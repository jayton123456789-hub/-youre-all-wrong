import type { Cue, CueSequence } from '../domain/showpack/schema.js';
import type {
  VoiceAssetManifest,
  VoiceAssetManifestEntry,
  VoicePreflightActivity,
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
  activity: VoicePreflightActivity | null;
}

export interface VoicePlaybackCallbacks {
  signal?: AbortSignal;
  muted?: boolean;
  volume?: number;
  playbackRate?: number;
  pauseScale?: number;
  onCue?: (cue: Cue | null) => void;
}

interface LoadedVoiceAsset {
  manifest: VoiceAssetManifestEntry;
  objectUrl: string;
}

export interface ShowpackAudioAssetManifestEntry {
  id: string;
  kind: 'audio';
  bytes: number;
  sha256: string;
}

interface ShowpackAssetManifestResponse {
  assets: Array<{
    id: string;
    kind: 'audio' | 'image' | 'font' | 'video';
    bytes: number;
    sha256: string;
  }>;
}

export interface LoadedShowpackAudioAsset {
  manifest: ShowpackAudioAssetManifestEntry;
  objectUrl: string;
}

interface ActiveShowpackSound {
  audio: HTMLAudioElement;
  masterVolume: number;
  cancel?: (error: Error) => void;
}

const HOST_HEADER = 'X-YAW-HOST-KEY';
const STATUS_POLL_MS = 750;
const AUDIO_LOAD_CONCURRENCY = 6;

function abortError(): DOMException {
  return new DOMException('Voice playback was interrupted.', 'AbortError');
}

function decibelsToLinear(decibels: number): number {
  return Math.max(0, Math.min(1, 10 ** (decibels / 20)));
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
  readonly #showpackAudio = new Map<string, LoadedShowpackAudioAsset>();
  readonly #activeShowpackSounds = new Map<string, ActiveShowpackSound>();
  #activeAudio: HTMLAudioElement | null = null;
  #disposed = false;
  #muted = false;

  constructor(
    readonly manifest: VoiceAssetManifest,
    assets: Map<string, LoadedVoiceAsset>,
    showpackAudio: Map<string, LoadedShowpackAudioAsset> = new Map(),
  ) {
    this.#assets = assets;
    this.#showpackAudio = showpackAudio;
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
    for (const { audio } of this.#activeShowpackSounds.values()) audio.muted = muted;
  }

  async unlock(): Promise<void> {
    const firstVoice = this.#assets.values().next().value as LoadedVoiceAsset | undefined;
    const firstShowpack = this.#showpackAudio.values().next().value as
      LoadedShowpackAudioAsset | undefined;
    const source = firstVoice?.objectUrl ?? firstShowpack?.objectUrl;
    if (!source || this.#disposed) return;
    const audio = new Audio(source);
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
    if (audio) {
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
    for (const assetId of [...this.#activeShowpackSounds.keys()]) {
      this.#stopShowpackSoundImmediately(assetId);
    }
  }

  async playSequence(
    cues: CueSequence,
    {
      signal,
      muted = false,
      volume = 1,
      playbackRate = 1,
      pauseScale = 1,
      onCue,
    }: VoicePlaybackCallbacks = {},
  ): Promise<void> {
    if (this.#disposed) throw new Error('The voice bank has already been disposed.');
    const sequenceSounds = new Set<string>();
    try {
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
        if (cue.type === 'sound') {
          onCue?.(cue);
          if (cue.action === 'play') sequenceSounds.add(cue.assetId);
          await this.#applyShowpackSoundCue(cue, Math.max(0, Math.min(1, volume)), muted, signal);
          continue;
        }
        if (cue.type !== 'line') {
          onCue?.(cue);
          continue;
        }

        const loaded = this.#assets.get(cue.id);
        if (!loaded) throw new Error(`The pre-cooked voice clip "${cue.id}" is missing.`);
        await waitFor(loaded.manifest.pauseBeforeMs * pauseScale, signal);
        onCue?.(cue);
        if (muted || this.#muted) {
          await waitFor(loaded.manifest.durationMs / playbackRate, signal);
        } else {
          await this.#playAsset(loaded, Math.max(0, Math.min(1, volume)), playbackRate, signal);
        }
        await waitFor(loaded.manifest.pauseAfterMs * pauseScale, signal);
      }
      onCue?.(null);
    } catch (error) {
      for (const assetId of sequenceSounds) this.#stopShowpackSoundImmediately(assetId);
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    for (const asset of this.#assets.values()) URL.revokeObjectURL(asset.objectUrl);
    for (const asset of this.#showpackAudio.values()) URL.revokeObjectURL(asset.objectUrl);
    this.#assets.clear();
    this.#showpackAudio.clear();
  }

  #stopShowpackSoundImmediately(assetId: string, reason: Error = abortError()): void {
    const active = this.#activeShowpackSounds.get(assetId);
    if (!active) return;
    this.#activeShowpackSounds.delete(assetId);
    active.audio.pause();
    active.audio.currentTime = 0;
    active.cancel?.(reason);
  }

  async #fadeShowpackVolume(
    audio: HTMLAudioElement,
    target: number,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const clampedTarget = Math.max(0, Math.min(1, target));
    if (durationMs <= 0) {
      audio.volume = clampedTarget;
      return;
    }
    const start = audio.volume;
    const steps = Math.max(1, Math.ceil(durationMs / 25));
    for (let step = 1; step <= steps; step += 1) {
      await waitFor(durationMs / steps, signal);
      audio.volume = start + (clampedTarget - start) * (step / steps);
    }
  }

  async #applyShowpackSoundCue(
    cue: Extract<Cue, { type: 'sound' }>,
    volume: number,
    muted: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (cue.action === 'play') {
      await this.#playShowpackSound(cue, volume, muted, signal);
      return;
    }

    const active = this.#activeShowpackSounds.get(cue.assetId);
    if (!active) {
      if (cue.action === 'stop') return;
      throw new Error(
        `Showpack sound "${cue.assetId}" cannot be ducked because it is not playing.`,
      );
    }

    if (cue.action === 'duck') {
      try {
        await this.#fadeShowpackVolume(
          active.audio,
          active.masterVolume * decibelsToLinear(cue.gainDb),
          cue.fadeMs,
          signal,
        );
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          this.#stopShowpackSoundImmediately(cue.assetId);
        }
        throw error;
      }
      return;
    }

    try {
      await this.#fadeShowpackVolume(active.audio, 0, cue.fadeMs, signal);
    } catch (error) {
      this.#stopShowpackSoundImmediately(cue.assetId);
      throw error;
    }
    this.#stopShowpackSoundImmediately(cue.assetId);
  }

  async #playShowpackSound(
    cue: Extract<Cue, { type: 'sound' }>,
    volume: number,
    muted: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    const loaded = this.#showpackAudio.get(cue.assetId);
    if (!loaded) throw new Error(`Showpack sound asset "${cue.assetId}" is missing.`);

    this.#stopShowpackSoundImmediately(cue.assetId);
    const audio = new Audio(loaded.objectUrl);
    const targetVolume = volume * decibelsToLinear(cue.gainDb);
    audio.preload = 'auto';
    audio.loop = cue.loop;
    audio.volume = cue.fadeMs > 0 ? 0 : targetVolume;
    audio.muted = muted || this.#muted;
    const active: ActiveShowpackSound = {
      audio,
      masterVolume: volume,
    };
    this.#activeShowpackSounds.set(cue.assetId, active);

    let resolvePlayback!: () => void;
    let rejectPlayback!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolvePlayback = resolve;
      rejectPlayback = reject;
    });
    const cleanup = () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onEnded = () => {
      cleanup();
      if (this.#activeShowpackSounds.get(cue.assetId)?.audio === audio) {
        this.#activeShowpackSounds.delete(cue.assetId);
      }
      resolvePlayback();
    };
    const onError = () => {
      this.#stopShowpackSoundImmediately(
        cue.assetId,
        new Error(`Showpack sound "${cue.assetId}" could not be played.`),
      );
    };
    const onAbort = () => {
      this.#stopShowpackSoundImmediately(cue.assetId, abortError());
    };
    active.cancel = (error) => {
      cleanup();
      rejectPlayback(error);
    };
    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await audio.play();
      await this.#fadeShowpackVolume(audio, targetVolume, cue.fadeMs, signal);
    } catch (error) {
      cleanup();
      this.#stopShowpackSoundImmediately(cue.assetId);
      void completion.catch(() => undefined);
      throw error instanceof Error ? error : new Error('Showpack audio playback was blocked.');
    }

    if (cue.loop) {
      cleanup();
      delete active.cancel;
      return;
    }
    await completion;
  }

  async #playAsset(
    asset: LoadedVoiceAsset,
    volume: number,
    playbackRate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    const audio = new Audio(asset.objectUrl);
    audio.preload = 'auto';
    audio.volume = volume;
    audio.playbackRate = Math.max(0.75, Math.min(1.25, playbackRate));
    audio.preservesPitch = true;
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
        audio.pause();
        audio.currentTime = 0;
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
    activity: null,
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
  const { body: showpackManifest } = await fetchJson<ShowpackAssetManifestResponse>(
    `${runtimeOrigin}/api/showpack/assets`,
    hostSecret,
    signal,
  );
  if (!Array.isArray(showpackManifest.assets)) {
    throw new Error('The showpack audio manifest is malformed.');
  }
  const showpackAudio: ShowpackAudioAssetManifestEntry[] = [];
  for (const asset of showpackManifest.assets) {
    if (
      typeof asset.id !== 'string' ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error('The showpack audio manifest contains an invalid asset.');
    }
    if (asset.kind === 'audio') showpackAudio.push({ ...asset, kind: 'audio' });
  }

  const loaded = new Map<string, LoadedVoiceAsset>();
  const loadedShowpackAudio = new Map<string, LoadedShowpackAudioAsset>();
  const totalAssets = manifest.assets.length + showpackAudio.length;
  let completed = 0;
  const publishLoadingProgress = () =>
    onProgress({
      phase: 'loading',
      completed,
      total: totalAssets,
      rendered: status.rendered,
      cached: status.cached,
      voiceName: manifest.voiceName,
      message: `Loading finished show audio… ${completed} / ${totalAssets}`,
      activity: null,
    });

  try {
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
      publishLoadingProgress();
    });

    await loadWithConcurrency(showpackAudio, AUDIO_LOAD_CONCURRENCY, async (asset) => {
      const response = await fetch(
        `${runtimeOrigin}/api/showpack/assets/${encodeURIComponent(asset.id)}`,
        {
          headers: { [HOST_HEADER]: hostSecret },
          cache: 'force-cache',
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Showpack sound "${asset.id}" answered ${response.status}.`);
      }
      const blob = await response.blob();
      if (blob.size !== asset.bytes) {
        throw new Error(`Showpack sound "${asset.id}" failed its size integrity check.`);
      }
      loadedShowpackAudio.set(asset.id, {
        manifest: asset,
        objectUrl: URL.createObjectURL(blob),
      });
      completed += 1;
      publishLoadingProgress();
    });
  } catch (error) {
    for (const asset of loaded.values()) URL.revokeObjectURL(asset.objectUrl);
    for (const asset of loadedShowpackAudio.values()) URL.revokeObjectURL(asset.objectUrl);
    throw error;
  }

  const bank = new VoiceBank(manifest, loaded, loadedShowpackAudio);
  onProgress({
    phase: 'ready',
    completed: totalAssets,
    total: totalAssets,
    rendered: status.rendered,
    cached: status.cached,
    voiceName: manifest.voiceName,
    message: `${manifest.assets.length} host lines and ${showpackAudio.length} show sounds loaded.`,
    activity: null,
  });
  return bank;
}
