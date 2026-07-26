import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  VoiceAssetManifest,
  VoiceAssetManifestEntry,
  VoiceEngineId,
  VoicePreflightActivity,
  VoicePreflightStatus,
} from '../domain/voice/preflight.js';
import { buildVoiceRenderPlan, type PlannedLine } from '../domain/voice/render-plan.js';
import type { Showpack } from '../domain/showpack/schema.js';

export interface VoiceWorkerJob {
  cueId: string;
  cacheKey: string;
  outputPath: string;
  text: string;
  delivery: PlannedLine['delivery'];
  pacePermille: number;
  energyPermille: number;
  pronunciation: Record<string, string>;
}

export interface VoiceWorkerManifest {
  protocolVersion: 1;
  voiceName: string;
  jobs: VoiceWorkerJob[];
}

export interface WorkerCueProgress {
  type: 'progress';
  cueId: string;
  cached: boolean;
}

export interface WorkerActivity {
  type: 'activity';
  activity: VoicePreflightActivity;
}

export type WorkerProgress = WorkerCueProgress | WorkerActivity;

export interface VoiceRendererConfig {
  engineId: VoiceEngineId;
  modelRevision: string;
  deliveryPresetRevision: string;
  pronunciationRevision: string;
  postProcessingRevision: string;
  voiceName: string;
  voiceProfileHashSource?: string;
}

const SYSTEM_VOICE_RENDERER: VoiceRendererConfig = {
  engineId: 'windows-system-speech',
  modelRevision: 'sapi5-pcm-v1',
  deliveryPresetRevision: 'yaw-system-voice-v1',
  pronunciationRevision: 'literal-substitution-v1',
  postProcessingRevision: 'sapi-pcm-v1',
  voiceName: 'Microsoft David Desktop',
};

export interface VoicePreflightOptions {
  pack: Showpack;
  cacheDirectory: string;
  workerPath: string;
  renderer?: VoiceRendererConfig;
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

export class UnavailableVoicePreflight implements VoicePreflightService {
  readonly #status: VoicePreflightStatus;

  constructor(message: string) {
    this.#status = {
      state: 'error',
      completed: 0,
      total: 0,
      rendered: 0,
      cached: 0,
      voiceName: 'Neural host unavailable',
      message,
      activity: null,
    };
  }

  get status(): VoicePreflightStatus {
    return publicStatus(this.#status);
  }

  get manifest(): null {
    return null;
  }

  fileForCue(_cueId: string): null {
    return null;
  }

  async prepare(): Promise<void> {
    // The runtime and lobby remain available so the setup problem can be shown
    // in context. The server's Start gate remains locked while this state is error.
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicStatus(status: VoicePreflightStatus): VoicePreflightStatus {
  return structuredClone(status);
}

function roughLineCount(count: number): string {
  return `${count} rough ${count === 1 ? 'line' : 'lines'}`;
}

export function voiceActivityMessage(activity: VoicePreflightActivity): string {
  switch (activity.type) {
    case 'quality-retry':
      return `Re-recording one rough line · quality pass ${activity.attempt}/${activity.maximumAttempts}`;
    case 'quality-deferred':
      return `${roughLineCount(activity.parkedCount)} parked · cooking the rest`;
    case 'quality-rescue-started':
      return `${roughLineCount(activity.parkedCount)} ready for quality rescue`;
    case 'quality-rescue-attempt':
      return `Rescuing 1 rough line · pass ${activity.rescueIndex}/${activity.rescueTotal}`;
    case 'quality-rescue-recovered':
      return 'Rough line rescued · checking the rest';
    case 'quality-rescue-exhausted':
      return 'One rough line resisted rescue · finishing quality checks';
    case 'quality-rescue-complete':
      return activity.failedCount === 0 && activity.recoveredCount > 0
        ? 'Rough line rescued · checking the rest'
        : 'Quality rescue finished · checking final results';
  }
}

interface VoiceCacheReceipt {
  schemaVersion: 1;
  cacheKey: string;
  waveSha256: string;
  durationMs: number;
}

function voiceCacheReceiptPath(wavePath: string): string {
  return `${wavePath}.json`;
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function validWaveFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size < 46) return false;
    waveDurationMs(await readFile(path));
    return true;
  } catch {
    return false;
  }
}

async function validVoiceCacheEntry(path: string, cacheKey: string): Promise<boolean> {
  try {
    const [waveDetails, receiptDetails] = await Promise.all([
      stat(path),
      stat(voiceCacheReceiptPath(path)),
    ]);
    if (
      !waveDetails.isFile() ||
      !receiptDetails.isFile() ||
      waveDetails.size < 46 ||
      receiptDetails.size < 2 ||
      receiptDetails.size > 4_096
    ) {
      return false;
    }
    const [wave, receiptSource] = await Promise.all([
      readFile(path),
      readFile(voiceCacheReceiptPath(path), 'utf8'),
    ]);
    const durationMs = waveDurationMs(wave);
    const receipt = JSON.parse(receiptSource) as Partial<VoiceCacheReceipt>;
    return (
      receipt.schemaVersion === 1 &&
      receipt.cacheKey === cacheKey &&
      receipt.waveSha256 === sha256Buffer(wave) &&
      receipt.durationMs === durationMs
    );
  } catch {
    return false;
  }
}

async function writeVoiceCacheReceipt(
  wavePath: string,
  cacheKey: string,
  wave: Buffer,
): Promise<void> {
  const receiptPath = voiceCacheReceiptPath(wavePath);
  const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
  const receipt: VoiceCacheReceipt = {
    schemaVersion: 1,
    cacheKey,
    waveSha256: sha256Buffer(wave),
    durationMs: waveDurationMs(wave),
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, receiptPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
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

  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd < 12) {
    throw new Error('Voice cache entry has an invalid RIFF container size.');
  }
  if (riffEnd > buffer.length) {
    throw new Error('Voice cache entry has a truncated RIFF container.');
  }
  if (riffEnd !== buffer.length) {
    throw new Error('Voice cache entry has bytes outside its RIFF container.');
  }

  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) {
      throw new Error('Voice cache entry has a truncated chunk header.');
    }
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    const contentEnd = contentOffset + chunkSize;
    if (contentEnd > riffEnd) {
      throw new Error(`Voice cache entry has a truncated "${chunkId}" chunk.`);
    }
    const paddedEnd = contentEnd + (chunkSize % 2);
    if (paddedEnd > riffEnd) {
      throw new Error(`Voice cache entry is missing padding after its "${chunkId}" chunk.`);
    }

    if (chunkId === 'fmt ') {
      if (sampleRate !== null) {
        throw new Error('Voice cache entry contains duplicate PCM format chunks.');
      }
      if (chunkSize !== 16 && chunkSize !== 18) {
        throw new Error('Voice cache entry must use a 16-byte or 18-byte PCM format chunk.');
      }

      const encoding = buffer.readUInt16LE(contentOffset);
      const channels = buffer.readUInt16LE(contentOffset + 2);
      const parsedSampleRate = buffer.readUInt32LE(contentOffset + 4);
      const byteRate = buffer.readUInt32LE(contentOffset + 8);
      const parsedBlockAlign = buffer.readUInt16LE(contentOffset + 12);
      const bitsPerSample = buffer.readUInt16LE(contentOffset + 14);

      if (encoding !== 1 && encoding !== 3) {
        throw new Error(`Voice cache entry uses unsupported WAVE encoding ${encoding}.`);
      }
      if (channels < 1 || channels > 2) {
        throw new Error(`Voice cache entry uses unsupported channel count ${channels}.`);
      }
      if (parsedSampleRate < 8_000 || parsedSampleRate > 192_000) {
        throw new Error(`Voice cache entry uses unsupported sample rate ${parsedSampleRate}.`);
      }

      const supportedBits =
        encoding === 1
          ? bitsPerSample === 8 ||
            bitsPerSample === 16 ||
            bitsPerSample === 24 ||
            bitsPerSample === 32
          : bitsPerSample === 32 || bitsPerSample === 64;
      if (!supportedBits) {
        throw new Error(
          `Voice cache entry uses unsupported ${bitsPerSample}-bit encoding ${encoding}.`,
        );
      }

      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (parsedBlockAlign !== expectedBlockAlign) {
        throw new Error(
          `Voice cache entry has block alignment ${parsedBlockAlign}; expected ${expectedBlockAlign}.`,
        );
      }
      const expectedByteRate = parsedSampleRate * expectedBlockAlign;
      if (byteRate !== expectedByteRate) {
        throw new Error(
          `Voice cache entry has byte rate ${byteRate}; expected ${expectedByteRate}.`,
        );
      }
      if (chunkSize === 18 && buffer.readUInt16LE(contentOffset + 16) !== 0) {
        throw new Error('Voice cache entry has an unsupported PCM format extension.');
      }

      sampleRate = parsedSampleRate;
      blockAlign = parsedBlockAlign;
    } else if (chunkId === 'data') {
      if (sampleRate === null || blockAlign === null) {
        throw new Error('Voice cache entry places audio data before its PCM format chunk.');
      }
      if (dataBytes !== null) {
        throw new Error('Voice cache entry contains duplicate audio data chunks.');
      }
      if (chunkSize === 0) {
        throw new Error('Voice cache entry contains an empty audio data chunk.');
      }
      if (chunkSize % blockAlign !== 0) {
        throw new Error(
          `Voice cache entry audio data is not aligned to ${blockAlign}-byte sample frames.`,
        );
      }
      dataBytes = chunkSize;
    }
    offset = paddedEnd;
  }

  if (sampleRate === null || blockAlign === null || dataBytes === null) {
    throw new Error('Voice cache entry is missing its PCM format or data chunk.');
  }
  const sampleFrames = dataBytes / blockAlign;
  return Math.max(1, Math.round((sampleFrames / sampleRate) * 1_000));
}

export async function runPowerShellVoiceWorker(
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
        const parsed = JSON.parse(line) as Partial<WorkerCueProgress>;
        if (
          parsed.type === 'progress' &&
          typeof parsed.cueId === 'string' &&
          typeof parsed.cached === 'boolean'
        ) {
          onProgress(parsed as WorkerProgress);
        }
      } catch {
        // Workers may emit startup diagnostics. Only typed JSON lines are protocol messages.
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
            `Voice worker exited with code ${code ?? 'unknown'}.${
              stderr.trim() ? ` ${stderr.trim()}` : ''
            }`,
          ),
        );
      }
    });
  });
}

export const runSystemVoiceWorker = runPowerShellVoiceWorker;

export class EpisodeVoicePreflight implements VoicePreflightService {
  readonly #cacheDirectory: string;
  readonly #workerPath: string;
  readonly #renderer: VoiceRendererConfig;
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
    this.#renderer = options.renderer ?? SYSTEM_VOICE_RENDERER;
    this.#runWorker = options.runWorker ?? runPowerShellVoiceWorker;
    this.#plan = buildVoiceRenderPlan(options.pack, {
      engineId: this.#renderer.engineId,
      modelRevision: this.#renderer.modelRevision,
      voiceProfileHash: sha256(this.#renderer.voiceProfileHashSource ?? this.#renderer.voiceName),
      deliveryPresetRevision: this.#renderer.deliveryPresetRevision,
      pronunciationRevision: this.#renderer.pronunciationRevision,
      postProcessingRevision: this.#renderer.postProcessingRevision,
    });
    this.#status = {
      state: 'preparing',
      completed: 0,
      total: this.#plan.length,
      rendered: 0,
      cached: 0,
      voiceName: this.#renderer.voiceName,
      message: 'Preparing the host voice…',
      activity: null,
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
      await mkdir(this.#cacheDirectory, { recursive: true });
      const jobs: VoiceWorkerJob[] = [];
      const pendingCueCountByJobCueId = new Map<string, number>();
      const scheduledJobCueIdByOutputPath = new Map<string, string>();
      let cachedCount = 0;
      for (const line of this.#plan) {
        const outputPath = join(this.#cacheDirectory, `${line.cacheKey}.wav`);
        this.#filesByCueId.set(line.cueId, outputPath);
        const scheduledJobCueId = scheduledJobCueIdByOutputPath.get(outputPath);
        if (scheduledJobCueId) {
          pendingCueCountByJobCueId.set(
            scheduledJobCueId,
            (pendingCueCountByJobCueId.get(scheduledJobCueId) ?? 1) + 1,
          );
          continue;
        }
        if (await validVoiceCacheEntry(outputPath, line.cacheKey)) {
          cachedCount += 1;
          continue;
        }
        await Promise.all(
          [outputPath, voiceCacheReceiptPath(outputPath)].map((path) =>
            unlink(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') {
                throw new Error(`Could not clear invalid voice cache entry "${path}".`, {
                  cause: error,
                });
              }
            }),
          ),
        );
        jobs.push({
          cueId: line.cueId,
          cacheKey: line.cacheKey,
          outputPath,
          text: line.text,
          delivery: line.delivery,
          pacePermille: line.pacePermille,
          energyPermille: line.energyPermille,
          pronunciation: line.pronunciation,
        });
        scheduledJobCueIdByOutputPath.set(outputPath, line.cueId);
        pendingCueCountByJobCueId.set(line.cueId, 1);
      }

      this.#publish({
        completed: cachedCount,
        cached: cachedCount,
        rendered: 0,
        activity: null,
        message:
          cachedCount === this.#plan.length
            ? 'Checking the finished voice cache…'
            : `Cooking ${this.#plan.length - cachedCount} host lines locally…`,
      });

      if (jobs.length > 0) {
        if (!existsSync(this.#workerPath)) {
          throw new Error(`The local voice worker is missing: ${this.#workerPath}`);
        }
        const workerManifest: VoiceWorkerManifest = {
          protocolVersion: 1,
          voiceName: this.#renderer.voiceName,
          jobs,
        };
        const manifestPath = join(this.#cacheDirectory, `render-${randomUUID()}.json`);
        await writeFile(manifestPath, JSON.stringify(workerManifest), 'utf8');
        try {
          let completed = cachedCount;
          let rendered = 0;
          let cached = cachedCount;
          await this.#runWorker(this.#workerPath, manifestPath, (progress) => {
            if (progress.type === 'activity') {
              this.#publish({
                activity: progress.activity,
                message: voiceActivityMessage(progress.activity),
              });
              return;
            }
            const representedCueCount = pendingCueCountByJobCueId.get(progress.cueId) ?? 1;
            completed += representedCueCount;
            if (progress.cached) cached += representedCueCount;
            else rendered += representedCueCount;
            this.#publish({
              completed,
              rendered,
              cached,
              activity: null,
              message: `Voicing the episode… ${completed} / ${this.#plan.length}`,
            });
          });
        } finally {
          await unlink(manifestPath).catch(() => undefined);
        }
      }

      const assets: VoiceAssetManifestEntry[] = [];
      for (const line of this.#plan) {
        const path = this.#filesByCueId.get(line.cueId);
        if (!path || !(await validWaveFile(path))) {
          if (path) {
            await Promise.all([
              unlink(path).catch(() => undefined),
              unlink(voiceCacheReceiptPath(path)).catch(() => undefined),
            ]);
          }
          throw new Error(`Voice worker did not produce a valid clip for "${line.cueId}".`);
        }
        const wave = await readFile(path);
        if (!(await validVoiceCacheEntry(path, line.cacheKey))) {
          await writeVoiceCacheReceipt(path, line.cacheKey, wave);
        }
        assets.push({
          cueId: line.cueId,
          durationMs: waveDurationMs(wave),
          pauseBeforeMs: line.pauseBeforeMs,
          pauseAfterMs: line.pauseAfterMs,
          delivery: line.delivery,
        });
      }

      this.#manifest = {
        protocolVersion: 1,
        engineId: this.#renderer.engineId,
        voiceName: this.#renderer.voiceName,
        assets,
      };
      this.#publish({
        state: 'ready',
        completed: this.#plan.length,
        activity: null,
        message: `${this.#plan.length} host lines are cooked and standing by.`,
      });
    } catch (error) {
      this.#publish({
        state: 'error',
        activity: null,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
