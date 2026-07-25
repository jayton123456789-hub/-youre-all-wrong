import type { Cue, CueSequence } from '../domain/showpack/schema.js';
import type {
  VoiceAssetManifest,
  VoiceAssetManifestEntry,
  VoicePreflightStatus,
} from '../domain/voice/preflight.js';

export type VoiceLoadPhase = 'checking' | 'rendering' | 'loading' | 'ready' | 'error';

export interface VoiceLoadProgress {
  phase: VoiceLoadPhase;
  completed: number;
  total: number;
  rendered: number;
  cached: number;
  voiceName: string;
  message: string;
}

export interface VoicePlaybackCallbacks {
  signal?: AbortSignal;
  muted?: boolean;
  volume?: number;
  onCue?: (cue: Cue | null) => void;
}

interface LoadedVoiceAsset {
  manifest: VoiceAssetManifestEntry;
  objectUrl: string;
}

const HOST_HEADER = 'X-YAW-HOST-KEY';
const STATUS_POLL_MS = 750;
const AUDIO_LOAD_CONCURRENCY = 6;

function abortError(): DOMException {
  return new DOMException('Voice playback was interrupted.', 'AbortError');
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson<T>(
  url: string,
  hostSecret: string,
  signal: AbortSignal,
  acceptedStatuses: number[] = [200],
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    headers: { [HOST_HEADER]: hostSecret },
    cache: 'no-store',
    signal,
  });
  const body = (await response.json()) as T;
  if (!acceptedStatuses.includes(response.status)) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `Voice service answered ${response.status}.`;
    throw new Error(message);
  }
  return { response, body };
}

async function loadWithConcurrency<T>(
  items: T[],
  concurrency: number,
  load: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await load(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

export class VoiceBank {
  readonly #assets = new Map<string, LoadedVoiceAsset>();
  #activeAudio: HTMLAudioElement | null = null;
  #disposed = false;
  #muted = false;

  constructor(
    readonly manifest: VoiceAssetManifest,
    assets: Map<string, LoadedVoiceAsset>,
  ) {
    this.#assets = assets;
  }

  get voiceName(): string {
    return this.manifest.voiceName;
  }

  get clipCount(): number {
    return this.#assets.size;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#activeAudio) this.#activeAudio.muted = muted;
  }

  async unlock(): Promise<void> {
    const first = this.#assets.values().next().value as LoadedVoiceAsset | undefined;
    if (!first || this.#disposed) return;
    const audio = new Audio(first.objectUrl);
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Electron permits autoplay. Browsers that do not will retry from the same user gesture
      // when the authored sequence begins.
    }
  }

  stop(): void {
    const audio = this.#activeAudio;
    if (!audio) return;
    this.#activeAudio = null;
    const originalVolume = audio.volume;
    let step = 0;
    const fade = window.setInterval(() => {
      step += 1;
      audio.volume = Math.max(0, originalVolume * (1 - step / 4));
      if (step >= 4) {
        window.clearInterval(fade);
        audio.pause();
        audio.currentTime = 0;
      }
    }, 15);
  }

  async playSequence(
    cues: CueSequence,
    { signal, muted = false, volume = 1, onCue }: VoicePlaybackCallbacks = {},
  ): Promise<void> {
    if (this.#disposed) throw new Error('The voice bank has already been disposed.');
    for (const cue of cues) {
      if (signal?.aborted) throw abortError();

      if (cue.type === 'pause') {
        onCue?.(cue);
        await waitFor(cue.durationMs, signal);
        continue;
      }
      if (cue.type === 'stage') {
        onCue?.(cue);
        await waitFor(cue.durationMs, signal);
        continue;
      }
      if (cue.type !== 'line') {
        onCue?.(cue);
        continue;
      }

      const loaded = this.#assets.get(cue.id);
      if (!loaded) throw new Error(`The pre-cooked voice clip "${cue.id}" is missing.`);
      await waitFor(loaded.manifest.pauseBeforeMs, signal);
      onCue?.(cue);
      if (muted || this.#muted) {
        await waitFor(loaded.manifest.durationMs, signal);
      } else {
        await this.#playAsset(loaded, Math.max(0, Math.min(1, volume)), signal);
      }
      await waitFor(loaded.manifest.pauseAfterMs, signal);
    }
    onCue?.(null);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    for (const asset of this.#assets.values()) URL.revokeObjectURL(asset.objectUrl);
    this.#assets.clear();
  }

  async #playAsset(asset: LoadedVoiceAsset, volume: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    const audio = new Audio(asset.objectUrl);
    audio.preload = 'auto';
    audio.volume = volume;
    audio.muted = this.#muted;
    this.#activeAudio = audio;

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        if (this.#activeAudio === audio) this.#activeAudio = null;
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('A pre-cooked host clip could not be played.'));
      };
      const onAbort = () => {
        this.stop();
        cleanup();
        reject(abortError());
      };
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      void audio.play().catch((error: unknown) => {
        cleanup();
        reject(
          new Error(
            error instanceof Error
              ? `Audio playback was blocked: ${error.message}`
              : 'Audio playback was blocked.',
          ),
        );
      });
    });
  }
}

export async function prepareVoiceBank(
  runtimeOrigin: string,
  hostSecret: string,
  signal: AbortSignal,
  onProgress: (progress: VoiceLoadProgress) => void,
): Promise<VoiceBank> {
  onProgress({
    phase: 'checking',
    completed: 0,
    total: 0,
    rendered: 0,
    cached: 0,
    voiceName: 'Local host',
    message: 'Inspecting the episode voice cache…',
  });

  let status: VoicePreflightStatus;
  for (;;) {
    const result = await fetchJson<VoicePreflightStatus>(
      `${runtimeOrigin}/api/voice/status`,
      hostSecret,
      signal,
      [200, 503],
    );
    status = result.body;
    onProgress({
      phase: status.state === 'error' ? 'error' : 'rendering',
      ...status,
    });
    if (status.state === 'error') throw new Error(status.message);
    if (status.state === 'ready') break;
    await waitFor(STATUS_POLL_MS, signal);
  }

  const { body: manifest } = await fetchJson<VoiceAssetManifest>(
    `${runtimeOrigin}/api/voice/manifest`,
    hostSecret,
    signal,
  );
  const loaded = new Map<string, LoadedVoiceAsset>();
  let completed = 0;
  await loadWithConcurrency(manifest.assets, AUDIO_LOAD_CONCURRENCY, async (asset) => {
    const response = await fetch(
      `${runtimeOrigin}/api/voice/audio/${encodeURIComponent(asset.cueId)}`,
      {
        headers: { [HOST_HEADER]: hostSecret },
        cache: 'force-cache',
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Host clip "${asset.cueId}" answered ${response.status}.`);
    }
    const blob = await response.blob();
    if (blob.size < 46) throw new Error(`Host clip "${asset.cueId}" is incomplete.`);
    loaded.set(asset.cueId, {
      manifest: asset,
      objectUrl: URL.createObjectURL(blob),
    });
    completed += 1;
    onProgress({
      phase: 'loading',
      completed,
      total: manifest.assets.length,
      rendered: status.rendered,
      cached: status.cached,
      voiceName: manifest.voiceName,
      message: `Loading finished host audio… ${completed} / ${manifest.assets.length}`,
    });
  });

  const bank = new VoiceBank(manifest, loaded);
  onProgress({
    phase: 'ready',
    completed: manifest.assets.length,
    total: manifest.assets.length,
    rendered: status.rendered,
    cached: status.cached,
    voiceName: manifest.voiceName,
    message: `${manifest.assets.length} lines cooked, measured, and loaded.`,
  });
  return bank;
}
