import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTestShowpack } from '../domain/testkit/showpack.js';
import {
  EpisodeVoicePreflight,
  UnavailableVoicePreflight,
  voiceActivityMessage,
  waveDurationMs,
  type VoiceRendererConfig,
  type VoiceWorkerRunner,
} from './voice-preflight.js';

const renderer: VoiceRendererConfig = {
  engineId: 'chatterbox-tts',
  modelRevision: 'test-model',
  deliveryPresetRevision: 'test-delivery',
  pronunciationRevision: 'test-pronunciation',
  postProcessingRevision: 'test-post-processing',
  voiceName: 'Original Test Host',
  voiceProfileHashSource: 'authorized-reference-content-hash',
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yaw-voice-preflight-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface WaveChunkFixture {
  id: string;
  payload: Buffer;
  includePadding?: boolean;
}

interface WaveFixtureOptions {
  encoding?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  durationMs?: number;
  fmtSize?: number;
  fmtExtensionSize?: number;
  byteRate?: number;
  blockAlign?: number;
  dataBytes?: number;
  beforeData?: WaveChunkFixture[];
  afterData?: WaveChunkFixture[];
}

function waveChunk(fixture: WaveChunkFixture): Buffer {
  const paddingBytes = fixture.payload.length % 2 === 1 && fixture.includePadding !== false ? 1 : 0;
  const chunk = Buffer.alloc(8 + fixture.payload.length + paddingBytes);
  chunk.write(fixture.id, 0, 'ascii');
  chunk.writeUInt32LE(fixture.payload.length, 4);
  fixture.payload.copy(chunk, 8);
  return chunk;
}

function riffWave(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const wave = Buffer.alloc(12 + body.length);
  wave.write('RIFF', 0, 'ascii');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVE', 8, 'ascii');
  body.copy(wave, 12);
  return wave;
}

function waveFixture(options: WaveFixtureOptions = {}): Buffer {
  const encoding = options.encoding ?? 1;
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const fmtSize = options.fmtSize ?? 16;
  const expectedBlockAlign = channels * Math.ceil(bitsPerSample / 8);
  const blockAlign = options.blockAlign ?? expectedBlockAlign;
  const byteRate = options.byteRate ?? sampleRate * blockAlign;
  const sampleFrames = Math.max(
    1,
    Math.round(((options.durationMs ?? 1_000) / 1_000) * sampleRate),
  );
  const dataBytes = options.dataBytes ?? sampleFrames * Math.max(1, blockAlign);

  const format = Buffer.alloc(fmtSize);
  if (fmtSize >= 2) format.writeUInt16LE(encoding, 0);
  if (fmtSize >= 4) format.writeUInt16LE(channels, 2);
  if (fmtSize >= 8) format.writeUInt32LE(sampleRate, 4);
  if (fmtSize >= 12) format.writeUInt32LE(byteRate, 8);
  if (fmtSize >= 14) format.writeUInt16LE(blockAlign, 12);
  if (fmtSize >= 16) format.writeUInt16LE(bitsPerSample, 14);
  if (fmtSize >= 18) format.writeUInt16LE(options.fmtExtensionSize ?? 0, 16);

  const chunks = [
    waveChunk({ id: 'fmt ', payload: format }),
    ...(options.beforeData ?? []).map(waveChunk),
    waveChunk({ id: 'data', payload: Buffer.alloc(dataBytes) }),
    ...(options.afterData ?? []).map(waveChunk),
  ];
  return riffWave(chunks);
}

function pcmWave(durationMs: number): Buffer {
  return waveFixture({ durationMs });
}

describe('voice preflight', () => {
  it('represents missing neural setup as a stable error without starting a worker', async () => {
    const voice = new UnavailableVoicePreflight(
      'Approve and install the neural host before starting the show.',
    );

    await expect(voice.prepare()).resolves.toBeUndefined();
    expect(voice.status).toEqual({
      state: 'error',
      completed: 0,
      total: 0,
      rendered: 0,
      cached: 0,
      voiceName: 'Neural host unavailable',
      message: 'Approve and install the neural host before starting the show.',
      activity: null,
    });
    expect(voice.manifest).toBeNull();
    expect(voice.fileForCue('anything')).toBeNull();
  });

  it('derives exact clip timing from PCM wave metadata', () => {
    expect(waveDurationMs(pcmWave(1_375))).toBe(1_375);
  });

  it('accepts the concrete system-speech and Chatterbox output formats', () => {
    const systemSpeechWave = waveFixture({
      encoding: 1,
      channels: 1,
      sampleRate: 22_050,
      bitsPerSample: 16,
      fmtSize: 18,
      durationMs: 1_000,
    });
    const chatterboxWave = waveFixture({
      encoding: 3,
      channels: 1,
      sampleRate: 24_000,
      bitsPerSample: 32,
      durationMs: 1_000,
      beforeData: [
        { id: 'fact', payload: Buffer.alloc(4) },
        { id: 'PEAK', payload: Buffer.alloc(16) },
      ],
    });
    const paddedMetadataWave = waveFixture({
      durationMs: 1_000,
      beforeData: [{ id: 'JUNK', payload: Buffer.from([1, 2, 3]) }],
    });

    expect(waveDurationMs(systemSpeechWave)).toBe(1_000);
    expect(waveDurationMs(chatterboxWave)).toBe(1_000);
    expect(waveDurationMs(paddedMetadataWave)).toBe(1_000);
  });

  it('rejects corrupt cache entries instead of guessing their duration', () => {
    expect(() => waveDurationMs(Buffer.from('not audio'))).toThrow(/RIFF\/WAVE/u);

    const truncated = pcmWave(250);
    truncated.writeUInt32LE(truncated.length * 2, 40);
    expect(() => waveDurationMs(truncated)).toThrow(/truncated "data" chunk/u);
  });

  it.each([
    [
      'a 12-byte fmt chunk',
      () => waveFixture({ fmtSize: 12 }),
      /16-byte or 18-byte PCM format chunk/u,
    ],
    ['an unsupported encoding', () => waveFixture({ encoding: 6 }), /unsupported WAVE encoding/u],
    ['three channels', () => waveFixture({ channels: 3 }), /unsupported channel count/u],
    ['an impossible sample rate', () => waveFixture({ sampleRate: 1_000 }), /sample rate/u],
    ['an impossible byte rate', () => waveFixture({ byteRate: 1 }), /byte rate/u],
    ['an impossible block alignment', () => waveFixture({ blockAlign: 1 }), /block alignment/u],
    ['a 12-bit integer encoding', () => waveFixture({ bitsPerSample: 12 }), /unsupported 12-bit/u],
    [
      'a 16-bit floating-point encoding',
      () => waveFixture({ encoding: 3, bitsPerSample: 16 }),
      /unsupported 16-bit/u,
    ],
    ['misaligned sample data', () => waveFixture({ dataBytes: 3 }), /not aligned/u],
    ['an empty data chunk', () => waveFixture({ dataBytes: 0 }), /empty audio data/u],
    [
      'a nonempty PCM format extension',
      () => waveFixture({ fmtSize: 18, fmtExtensionSize: 1 }),
      /unsupported PCM format extension/u,
    ],
    [
      'a duplicate data chunk',
      () =>
        waveFixture({
          afterData: [{ id: 'data', payload: Buffer.alloc(2) }],
        }),
      /duplicate audio data chunks/u,
    ],
    [
      'audio data before the format chunk',
      () => {
        const standard = waveFixture({ dataBytes: 2 });
        const formatChunk = standard.subarray(12, 36);
        const dataChunk = standard.subarray(36);
        return riffWave([dataChunk, formatChunk]);
      },
      /audio data before/u,
    ],
    [
      'a duplicate format chunk',
      () => {
        const standard = waveFixture({ dataBytes: 2 });
        const formatChunk = standard.subarray(12, 36);
        const dataChunk = standard.subarray(36);
        return riffWave([formatChunk, formatChunk, dataChunk]);
      },
      /duplicate PCM format chunks/u,
    ],
    [
      'a missing odd-chunk padding byte',
      () =>
        waveFixture({
          afterData: [{ id: 'JUNK', payload: Buffer.from([1]), includePadding: false }],
        }),
      /missing padding/u,
    ],
    [
      'bytes after the RIFF container',
      () => Buffer.concat([waveFixture(), Buffer.from([0])]),
      /outside its RIFF container/u,
    ],
    [
      'a partial trailing chunk header',
      () => {
        const malformed = Buffer.concat([waveFixture(), Buffer.alloc(4)]);
        malformed.writeUInt32LE(malformed.length - 8, 4);
        return malformed;
      },
      /truncated chunk header/u,
    ],
  ])('rejects %s', (_description, buildWave, expectedError) => {
    expect(() => waveDurationMs(buildWave())).toThrow(expectedError);
  });

  it('uses a complete valid cache without requiring or launching a worker', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');

    const firstRun = vi.fn<VoiceWorkerRunner>(async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    });
    const first = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: firstRun,
    });
    await first.prepare();
    expect(firstRun).toHaveBeenCalledOnce();

    const shouldNotRun = vi.fn<VoiceWorkerRunner>(async () => {
      throw new Error('A fully cached episode must not launch its voice worker.');
    });
    const cached = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath: join(directory, 'missing-worker.ps1'),
      renderer,
      runWorker: shouldNotRun,
    });
    await cached.prepare();

    expect(shouldNotRun).not.toHaveBeenCalled();
    expect(cached.status).toMatchObject({
      state: 'ready',
      completed: cached.status.total,
      rendered: 0,
      cached: cached.status.total,
    });
    expect(cached.manifest?.assets).toHaveLength(cached.status.total);
  });

  it('shows quality retries as activity without advancing the cooked-line count', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');

    let duringRetry:
      | {
          completed: number;
          rendered: number;
          cached: number;
          message: string;
          activity: EpisodeVoicePreflight['status']['activity'];
        }
      | undefined;
    let preflight!: EpisodeVoicePreflight;
    const worker: VoiceWorkerRunner = async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      onProgress({
        type: 'activity',
        activity: {
          type: 'quality-retry',
          attempt: 2,
          maximumAttempts: 3,
        },
      });
      duringRetry = preflight.status;
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    };
    preflight = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: worker,
    });

    await preflight.prepare();

    expect(duringRetry).toMatchObject({
      completed: 0,
      rendered: 0,
      cached: 0,
      message: 'Re-recording one rough line · quality pass 2/3',
      activity: {
        type: 'quality-retry',
        attempt: 2,
        maximumAttempts: 3,
      },
    });
    expect(duringRetry?.message).not.toMatch(/cue|transcript|word error/iu);
    expect(preflight.status.activity).toBeNull();
    expect(preflight.status.completed).toBe(preflight.status.total);
  });

  it('keeps every deferred rescue update non-counting and player-safe', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');

    const activityStatuses: EpisodeVoicePreflight['status'][] = [];
    let preflight!: EpisodeVoicePreflight;
    const worker: VoiceWorkerRunner = async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      const activities = [
        { type: 'quality-deferred' as const, parkedCount: 1 },
        {
          type: 'quality-rescue-started' as const,
          parkedCount: 1,
          rescueTotal: 8,
          maximumAttempts: 9,
        },
        {
          type: 'quality-rescue-attempt' as const,
          rescueIndex: 1,
          rescueTotal: 8,
          attempt: 2,
          maximumAttempts: 9,
        },
        { type: 'quality-rescue-recovered' as const, remainingParked: 0 },
      ];
      for (const activity of activities) {
        onProgress({ type: 'activity', activity });
        activityStatuses.push(preflight.status);
      }
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    };
    preflight = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: worker,
    });

    await preflight.prepare();

    expect(
      activityStatuses.map(({ completed, rendered, cached }) => ({ completed, rendered, cached })),
    ).toEqual([
      { completed: 0, rendered: 0, cached: 0 },
      { completed: 0, rendered: 0, cached: 0 },
      { completed: 0, rendered: 0, cached: 0 },
      { completed: 0, rendered: 0, cached: 0 },
    ]);
    expect(activityStatuses.map(({ message }) => message)).toEqual([
      '1 rough line parked · cooking the rest',
      '1 rough line ready for quality rescue',
      'Rescuing 1 rough line · pass 1/8',
      'Rough line rescued · checking the rest',
    ]);
    expect(JSON.stringify(activityStatuses)).not.toMatch(
      /cueId|profile|seed|reason|transcript|word error/iu,
    );
    expect(preflight.status.activity).toBeNull();
    expect(preflight.status.completed).toBe(preflight.status.total);
  });

  it('pluralizes parked rescue work without exposing technical details', () => {
    expect(voiceActivityMessage({ type: 'quality-deferred', parkedCount: 2 })).toBe(
      '2 rough lines parked · cooking the rest',
    );
    expect(
      voiceActivityMessage({
        type: 'quality-rescue-complete',
        recoveredCount: 2,
        failedCount: 0,
      }),
    ).toBe('Rough line rescued · checking the rest');
  });

  it('renders identical lines once while keeping every cue addressable', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');

    const pack = makeTestShowpack();
    const originalLine = pack.episode.opening[0];
    if (!originalLine || originalLine.type !== 'line') {
      throw new Error('The test opening unexpectedly had no spoken line.');
    }
    pack.episode.opening.push({
      ...originalLine,
      id: 'opening-line-repeated',
    });

    let renderedJobCount = 0;
    const worker = vi.fn<VoiceWorkerRunner>(async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      expect(new Set(manifest.jobs.map((job) => job.outputPath)).size).toBe(manifest.jobs.length);
      renderedJobCount = manifest.jobs.length;
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    });
    const preflight = new EpisodeVoicePreflight({
      pack,
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: worker,
    });

    await preflight.prepare();

    expect(worker).toHaveBeenCalledOnce();
    expect(renderedJobCount).toBe(preflight.status.total - 1);
    expect(preflight.status).toMatchObject({
      state: 'ready',
      completed: preflight.status.total,
      rendered: preflight.status.total,
      cached: 0,
    });
    expect(preflight.fileForCue('opening-line-repeated')).toBe(
      preflight.fileForCue(originalLine.id),
    );
    expect(preflight.manifest?.assets).toHaveLength(preflight.status.total);
  });

  it('resumes from a verified sidecar committed before a later worker failure', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');
    let committedOutputPath = '';

    const interruptedWorker: VoiceWorkerRunner = async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; cacheKey: string; outputPath: string }>;
      };
      const first = manifest.jobs[0];
      if (!first) throw new Error('The test render manifest unexpectedly had no jobs.');
      const wave = pcmWave(250);
      committedOutputPath = first.outputPath;
      await writeFile(first.outputPath, wave);
      await writeFile(
        `${first.outputPath}.json`,
        `${JSON.stringify({
          schemaVersion: 1,
          cacheKey: first.cacheKey,
          waveSha256: createHash('sha256').update(wave).digest('hex'),
          durationMs: 250,
        })}\n`,
      );
      onProgress({ type: 'progress', cueId: first.cueId, cached: false });
      throw new Error('simulated failure after the first verified clip');
    };
    const interrupted = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: interruptedWorker,
    });

    await expect(interrupted.prepare()).rejects.toThrow(/simulated failure/u);
    expect(committedOutputPath).not.toBe('');
    await expect(stat(committedOutputPath)).resolves.toMatchObject({ size: pcmWave(250).length });
    await expect(stat(`${committedOutputPath}.json`)).resolves.toMatchObject({
      size: expect.any(Number),
    });

    const resumedWorker = vi.fn<VoiceWorkerRunner>(async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      expect(manifest.jobs.map((job) => job.outputPath)).not.toContain(committedOutputPath);
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    });
    const resumed = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: resumedWorker,
    });
    await resumed.prepare();

    expect(resumedWorker).toHaveBeenCalledOnce();
    expect(resumed.status).toMatchObject({
      state: 'ready',
      completed: resumed.status.total,
    });
    expect(resumed.status.cached).toBeGreaterThanOrEqual(1);
  });

  it('deletes an incompatible cached wave and renders only that job again', async () => {
    const directory = await temporaryDirectory();
    const cacheDirectory = join(directory, 'cache');
    const workerPath = join(directory, 'worker.ps1');
    await writeFile(workerPath, '# test worker');

    const seedWorker: VoiceWorkerRunner = async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      for (const job of manifest.jobs) {
        await writeFile(job.outputPath, pcmWave(250));
        onProgress({ type: 'progress', cueId: job.cueId, cached: false });
      }
    };
    const seed = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: seedWorker,
    });
    await seed.prepare();

    const cueId = seed.manifest?.assets[0]?.cueId;
    if (!cueId) throw new Error('The test voice plan unexpectedly had no cues.');
    const corruptPath = seed.fileForCue(cueId);
    if (!corruptPath) throw new Error('The test cue did not resolve to a cache file.');
    await writeFile(corruptPath, waveFixture({ byteRate: 1 }));

    const repairWorker = vi.fn<VoiceWorkerRunner>(async (_path, manifestPath, onProgress) => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        jobs: Array<{ cueId: string; outputPath: string }>;
      };
      expect(manifest.jobs).toHaveLength(1);
      expect(manifest.jobs[0]).toMatchObject({ cueId, outputPath: corruptPath });
      await expect(stat(corruptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(corruptPath, pcmWave(500));
      onProgress({ type: 'progress', cueId, cached: false });
    });
    const repaired = new EpisodeVoicePreflight({
      pack: makeTestShowpack(),
      cacheDirectory,
      workerPath,
      renderer,
      runWorker: repairWorker,
    });
    await repaired.prepare();

    expect(repairWorker).toHaveBeenCalledOnce();
    expect(repaired.status).toMatchObject({
      state: 'ready',
      rendered: 1,
      cached: repaired.status.total - 1,
    });
    expect(waveDurationMs(await readFile(corruptPath))).toBe(500);
  });
});
