import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  VoiceAssetManifest,
  VoiceAssetManifestEntry,
  VoicePreflightStatus,
} from '../domain/voice/preflight.js';
import { buildVoiceRenderPlan, type PlannedLine } from '../domain/voice/render-plan.js';
import type { Showpack } from '../domain/showpack/schema.js';

const ENGINE_ID = 'windows-system-speech' as const;
const MODEL_REVISION = 'sapi5-pcm-v1';
const DELIVERY_PRESET_REVISION = 'yaw-system-voice-v1';
const PRONUNCIATION_REVISION = 'plain-text-v1';
const POST_PROCESSING_REVISION = 'sapi-pcm-v1';

interface VoiceWorkerJob {
  cueId: string;
  outputPath: string;
  text: string;
  delivery: PlannedLine['delivery'];
  pacePermille: number;
  energyPermille: number;
}

interface VoiceWorkerManifest {
  protocolVersion: 1;
  voiceName: string;
  jobs: VoiceWorkerJob[];
}

interface WorkerProgress {
  type: 'progress';
  cueId: string;
  cached: boolean;
}

export interface VoicePreflightOptions {
  pack: Showpack;
  cacheDirectory: string;
  workerPath: string;
  voiceName?: string;
  runWorker?: VoiceWorkerRunner;
}

export type VoiceWorkerRunner = (
  workerPath: string,
  manifestPath: string,
  onProgress: (progress: WorkerProgress) => void,
) => Promise<void>;

export type VoiceStatusListener = (status: VoicePreflightStatus) => void;

export interface VoicePreflightService {
  readonly status: VoicePreflightStatus;
  readonly manifest: VoiceAssetManifest | null;
  fileForCue(cueId: string): string | null;
  prepare(): Promise<void>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicStatus(status: VoicePreflightStatus): VoicePreflightStatus {
  return structuredClone(status);
}

async function validWaveFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size < 46) return false;
    const header = await readFile(path, { encoding: null });
    return (
      header.length >= 12 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE'
    );
  } catch {
    return false;
  }
}

export function waveDurationMs(buffer: Buffer): number {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Voice cache entry is not a RIFF/WAVE file.');
  }

  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 12 && contentOffset + 12 <= buffer.length) {
      byteRate = buffer.readUInt32LE(contentOffset + 8);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    if (byteRate > 0 && dataBytes > 0) break;
    offset = contentOffset + chunkSize + (chunkSize % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) {
    throw new Error('Voice cache entry is missing its PCM format or data chunk.');
  }
  return Math.max(1, Math.round((dataBytes / byteRate) * 1_000));
}

export async function runSystemVoiceWorker(
  workerPath: string,
  manifestPath: string,
  onProgress: (progress: WorkerProgress) => void,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        workerPath,
        '-ManifestPath',
        manifestPath,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });

    const output = createInterface({ input: child.stdout });
    output.on('line', (line) => {
      try {
        const parsed = JSON.parse(line) as Partial<WorkerProgress>;
        if (
          parsed.type === 'progress' &&
          typeof parsed.cueId === 'string' &&
          typeof parsed.cached === 'boolean'
        ) {
          onProgress(parsed as WorkerProgress);
        }
      } catch {
        // PowerShell can emit benign host messages. Only typed JSON lines are protocol messages.
      }
    });

    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      output.close();
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `Windows voice worker exited with code ${code ?? 'unknown'}.${
              stderr.trim() ? ` ${stderr.trim()}` : ''
            }`,
          ),
        );
      }
    });
  });
}

export class EpisodeVoicePreflight implements VoicePreflightService {
  readonly #cacheDirectory: string;
  readonly #workerPath: string;
  readonly #voiceName: string;
  readonly #plan: PlannedLine[];
  readonly #runWorker: VoiceWorkerRunner;
  readonly #listeners = new Set<VoiceStatusListener>();
  readonly #filesByCueId = new Map<string, string>();
  #manifest: VoiceAssetManifest | null = null;
  #preparation: Promise<void> | null = null;
  #status: VoicePreflightStatus;

  constructor(options: VoicePreflightOptions) {
    this.#cacheDirectory = resolve(options.cacheDirectory);
    this.#workerPath = resolve(options.workerPath);
    this.#voiceName = options.voiceName ?? 'Microsoft David Desktop';
    this.#runWorker = options.runWorker ?? runSystemVoiceWorker;
    this.#plan = buildVoiceRenderPlan(options.pack, {
      engineId: ENGINE_ID,
      modelRevision: MODEL_REVISION,
      voiceProfileHash: sha256(this.#voiceName),
      deliveryPresetRevision: DELIVERY_PRESET_REVISION,
      pronunciationRevision: PRONUNCIATION_REVISION,
      postProcessingRevision: POST_PROCESSING_REVISION,
    });
    this.#status = {
      state: 'preparing',
      completed: 0,
      total: this.#plan.length,
      rendered: 0,
      cached: 0,
      voiceName: this.#voiceName,
      message: 'Preparing the host voice…',
    };
  }

  get status(): VoicePreflightStatus {
    return publicStatus(this.#status);
  }

  get manifest(): VoiceAssetManifest | null {
    return this.#manifest ? structuredClone(this.#manifest) : null;
  }

  fileForCue(cueId: string): string | null {
    return this.#filesByCueId.get(cueId) ?? null;
  }

  subscribe(listener: VoiceStatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(patch: Partial<VoicePreflightStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const listener of this.#listeners) listener(this.status);
  }

  prepare(): Promise<void> {
    this.#preparation ??= this.#prepareOnce();
    return this.#preparation;
  }

  async #prepareOnce(): Promise<void> {
    try {
      if (!existsSync(this.#workerPath)) {
        throw new Error(`The local voice worker is missing: ${this.#workerPath}`);
      }
      await mkdir(this.#cacheDirectory, { recursive: true });
      const jobs: VoiceWorkerJob[] = [];
      let cachedCount = 0;
      for (const line of this.#plan) {
        const outputPath = join(this.#cacheDirectory, `${line.cacheKey}.wav`);
        this.#filesByCueId.set(line.cueId, outputPath);
        if (await validWaveFile(outputPath)) {
          cachedCount += 1;
        }
        jobs.push({
          cueId: line.cueId,
          outputPath,
          text: line.text,
          delivery: line.delivery,
          pacePermille: line.pacePermille,
          energyPermille: line.energyPermille,
        });
      }

      this.#publish({
        completed: 0,
        cached: cachedCount,
        rendered: 0,
        message:
          cachedCount === this.#plan.length
            ? 'Checking the finished voice cache…'
            : `Cooking ${this.#plan.length - cachedCount} host lines locally…`,
      });

      const workerManifest: VoiceWorkerManifest = {
        protocolVersion: 1,
        voiceName: this.#voiceName,
        jobs,
      };
      const manifestPath = join(this.#cacheDirectory, `render-${randomUUID()}.json`);
      await writeFile(manifestPath, JSON.stringify(workerManifest), 'utf8');
      try {
        let completed = 0;
        let rendered = 0;
        let cached = 0;
        await this.#runWorker(this.#workerPath, manifestPath, (progress) => {
          completed += 1;
          if (progress.cached) cached += 1;
          else rendered += 1;
          this.#publish({
            completed,
            rendered,
            cached,
            message: `Voicing the episode… ${completed} / ${this.#plan.length}`,
          });
        });
      } finally {
        await unlink(manifestPath).catch(() => undefined);
      }

      const assets: VoiceAssetManifestEntry[] = [];
      for (const line of this.#plan) {
        const path = this.#filesByCueId.get(line.cueId);
        if (!path || !(await validWaveFile(path))) {
          throw new Error(`Voice worker did not produce a valid clip for "${line.cueId}".`);
        }
        assets.push({
          cueId: line.cueId,
          durationMs: waveDurationMs(await readFile(path)),
          pauseBeforeMs: line.pauseBeforeMs,
          pauseAfterMs: line.pauseAfterMs,
          delivery: line.delivery,
        });
      }

      this.#manifest = {
        protocolVersion: 1,
        engineId: ENGINE_ID,
        voiceName: this.#voiceName,
        assets,
      };
      this.#publish({
        state: 'ready',
        completed: this.#plan.length,
        message: `${this.#plan.length} host lines are cooked and standing by.`,
      });
    } catch (error) {
      this.#publish({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
