import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { VoiceWorkerManifest } from './voice-preflight.js';
import {
  adaptVoiceWorkerBatchForQwen,
  adaptVoiceWorkerManifestForQwen,
  applyQwenPronunciation,
  createQwenRendererConfig,
  createQwenVoiceAdapterFromEnvironment,
  qwenProgressFromMessage,
  qwenRescueCompletionMatches,
  qwenWorkerFailureMessage,
  type QwenRendererOptions,
} from './qwen-renderer.js';

const BASE_REVISION = '5d83992436eae1d760afd27aff78a71d676296fc';
const ASR_REVISION = 'e8727524f962ee844a7319d92be39ac1bd25655a';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yaw-qwen-renderer-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface QwenFixture {
  root: string;
  options: QwenRendererOptions;
  workerPath: string;
  pythonPath: string;
  referencePath: string;
}

async function qwenFixture(): Promise<QwenFixture> {
  const root = await temporaryDirectory();
  const profileDirectory = join(root, 'voice');
  const baseModelPath = join(root, 'base');
  const asrModelPath = join(root, 'asr');
  await Promise.all([
    mkdir(profileDirectory, { recursive: true }),
    mkdir(baseModelPath, { recursive: true }),
    mkdir(asrModelPath, { recursive: true }),
  ]);

  const runtimeManifestPath = join(root, 'qwen-runtime-manifest.json');
  await writeFile(
    runtimeManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      installerRevision: 'yaw-qwen-runtime-v1',
      packages: {
        qwenTts: '0.1.1',
        transformers: '4.57.3',
      },
      models: {
        base: {
          repository: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
          revision: BASE_REVISION,
          license: 'Apache-2.0',
        },
        asr: {
          repository: 'openai/whisper-small.en',
          revision: ASR_REVISION,
          license: 'Apache-2.0',
        },
      },
      qa: {
        policyRevision: 'yaw-qwen-audio-qa-v1',
        silentGuardMs: 200,
      },
    }),
  );
  await Promise.all([
    writeFile(
      join(baseModelPath, '.yaw-model.json'),
      JSON.stringify({
        schemaVersion: 1,
        repository: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        revision: BASE_REVISION,
      }),
    ),
    writeFile(
      join(asrModelPath, '.yaw-model.json'),
      JSON.stringify({
        schemaVersion: 1,
        repository: 'openai/whisper-small.en',
        revision: ASR_REVISION,
      }),
    ),
  ]);

  const referencePath = join(profileDirectory, 'reference.wav');
  const reference = Buffer.from('approved Voice 2 reference bytes');
  await writeFile(referencePath, reference);
  const approvalPath = join(profileDirectory, 'approval.json');
  await writeFile(
    approvalPath,
    JSON.stringify({
      schemaVersion: 1,
      status: 'approved',
      engine: 'qwen3-tts',
      syntheticOriginal: true,
      voiceId: 'original-host-v1',
      voiceName: 'The Host',
      approvedAsRendered: true,
      reference: {
        file: 'reference.wav',
        sha256: sha256(reference),
        transcript: "Welcome to You're All Wrong.",
      },
    }),
  );

  const workerPath = join(root, 'qwen-voice-worker.py');
  const pythonPath = join(root, 'python.exe');
  await Promise.all([writeFile(workerPath, '# worker'), writeFile(pythonPath, '')]);

  return {
    root,
    options: {
      runtimeManifestPath,
      approvalPath,
      baseModelPath,
      asrModelPath,
    },
    workerPath,
    pythonPath,
    referencePath,
  };
}

function genericManifest(outputPath: string): VoiceWorkerManifest {
  return {
    protocolVersion: 1,
    voiceName: 'The Host',
    jobs: [
      {
        cueId: 'question-1',
        cacheKey: 'a'.repeat(64),
        outputPath,
        text: 'NASA met a NASAL scientist. Read YAW twice.',
        delivery: 'smug',
        pacePermille: 940,
        energyPermille: 720,
        pronunciation: {
          NASA: 'NASS-uh',
          YAW: "You're All Wrong",
        },
      },
    ],
  };
}

describe('Qwen renderer identity', () => {
  it('binds cache identity to the exact approved reference and pinned local models', async () => {
    const fixture = await qwenFixture();
    const renderer = await createQwenRendererConfig(fixture.options);

    expect(renderer).toMatchObject({
      engineId: 'qwen3-tts',
      voiceName: 'The Host',
      deliveryPresetRevision: 'yaw-qwen-natural-delivery-v1',
      pronunciationRevision: 'whole-token-substitution-v2',
    });
    expect(renderer.modelRevision).toContain(BASE_REVISION);
    expect(renderer.modelRevision).toContain(ASR_REVISION);
    expect(renderer.postProcessingRevision).toContain('no-tempo');
    expect(renderer.postProcessingRevision).toContain('no-pitch');
    expect(renderer.voiceProfileHashSource).toContain(sha256('approved Voice 2 reference bytes'));
    expect(renderer.voiceProfileHashSource).not.toContain(fixture.root);

    await writeFile(fixture.referencePath, 'mutated reference');
    await expect(createQwenRendererConfig(fixture.options)).rejects.toThrow(
      /exact SHA-256 integrity check/u,
    );
  });

  it('rejects a model directory whose marker is not the runtime pin', async () => {
    const fixture = await qwenFixture();
    await writeFile(
      join(fixture.options.baseModelPath, '.yaw-model.json'),
      JSON.stringify({
        schemaVersion: 1,
        repository: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        revision: '0'.repeat(40),
      }),
    );

    await expect(createQwenRendererConfig(fixture.options)).rejects.toThrow(
      /does not match the pinned Qwen runtime revision/u,
    );
  });
});

describe('Qwen preflight adapter', () => {
  it('keeps worker warnings out of the lobby error while pointing to full diagnostics', () => {
    const diagnosticLogPath = 'C:\\voice-cache\\voice-cook-latest.log';
    const stderr = [
      'FutureWarning: Some dependency warning that should never reach players.',
      'UserWarning: Flash attention is unavailable.',
      'Traceback (most recent call last):',
      'QwenVoiceError: Voice QA failed after 3 attempts: cue "intro-2" (attempt 1: word error rate 0.250 exceeds 0.180)',
    ].join('\n');

    const message = qwenWorkerFailureMessage(1, null, stderr, diagnosticLogPath);

    expect(message).toContain('cue "intro-2"');
    expect(message).toContain('word error rate 0.250 exceeds 0.180');
    expect(message).toContain('Restart the app and cook again to resume.');
    expect(message).toContain(diagnosticLogPath);
    expect(message).not.toContain('FutureWarning');
    expect(message).not.toContain('Flash attention');
    expect(message).not.toContain('Traceback');
  });

  it('prefers the typed worker failure over noisy stderr', () => {
    const message = qwenWorkerFailureMessage(
      1,
      'Voice QA failed after 3 attempts: cue "question-4" failed transcript QA.',
      'FutureWarning: noise\nRuntimeError: unrelated wrapper failure',
      'C:\\voice-cache\\voice-cook-latest.log',
    );

    expect(message).toContain('cue "question-4"');
    expect(message).not.toContain('unrelated wrapper failure');
    expect(message).not.toContain('FutureWarning');
  });

  it('applies whole-token pronunciation without changing neighboring words', () => {
    expect(
      applyQwenPronunciation('NASA met a NASAL scientist. Read yaw and YAW.', {
        NASA: 'NASS-uh',
        YAW: "You're All Wrong",
      }),
    ).toBe("NASS-uh met a NASAL scientist. Read You're All Wrong and You're All Wrong.");
    expect(applyQwenPronunciation('RND', { RND: 'R and D costs $&5' })).toBe('R and D costs $&5');
  });

  it('translates generic jobs without pitch, tempo, or path changes', async () => {
    const fixture = await qwenFixture();
    const outputPath = join(fixture.root, 'cache', 'question-1.wav');
    const qaReportPath = join(fixture.root, 'qa.json');
    const adapted = adaptVoiceWorkerManifestForQwen(
      genericManifest(outputPath),
      fixture.options,
      qaReportPath,
    );

    expect(adapted).toMatchObject({
      protocolVersion: 1,
      operation: 'render',
      runtimeManifestPath: resolve(fixture.options.runtimeManifestPath),
      voiceApprovalPath: resolve(fixture.options.approvalPath),
      baseModelPath: resolve(fixture.options.baseModelPath),
      asrModelPath: resolve(fixture.options.asrModelPath),
      qaReportPath: resolve(qaReportPath),
      jobs: [
        {
          cueId: 'question-1',
          cacheKey: 'a'.repeat(64),
          outputPath: resolve(outputPath),
          text: "NASS-uh met a NASAL scientist. Read You're All Wrong twice.",
          qaTranscript: "NASS-uh met a NASAL scientist. Read You're All Wrong twice.",
          language: 'English',
        },
      ],
    });
    expect(adapted.jobs[0]).not.toHaveProperty('pacePermille');
    expect(adapted.jobs[0]).not.toHaveProperty('energyPermille');
    expect(adapted.jobs[0]).not.toHaveProperty('delivery');
    expect(JSON.stringify(adapted)).not.toMatch(/tempo|pitch/iu);
  });

  it('coalesces identical shared-cache jobs and retains every source cue for progress', async () => {
    const fixture = await qwenFixture();
    const outputPath = join(fixture.root, 'cache', 'shared.wav');
    const manifest = genericManifest(outputPath);
    const original = manifest.jobs[0];
    if (!original) throw new Error('The fixture unexpectedly has no generic render job.');
    manifest.jobs.push({
      ...original,
      cueId: 'question-2',
      pronunciation: { ...original.pronunciation },
    });

    const adapted = adaptVoiceWorkerBatchForQwen(
      manifest,
      fixture.options,
      join(fixture.root, 'qa.json'),
    );

    expect(adapted.manifest.jobs).toHaveLength(1);
    expect(adapted.manifest.jobs[0]).toMatchObject({
      cueId: 'question-1',
      outputPath: resolve(outputPath),
    });
    expect(adapted.cueIdsByRenderCueId.get('question-1')).toEqual(['question-1', 'question-2']);
  });

  it('rejects a shared output path when its render content is not identical', async () => {
    const fixture = await qwenFixture();
    const outputPath = join(fixture.root, 'cache', 'shared.wav');
    const manifest = genericManifest(outputPath);
    const original = manifest.jobs[0];
    if (!original) throw new Error('The fixture unexpectedly has no generic render job.');
    manifest.jobs.push({
      ...original,
      cueId: 'question-2',
      text: 'This is different speech.',
      pronunciation: { ...original.pronunciation },
    });

    expect(() =>
      adaptVoiceWorkerBatchForQwen(manifest, fixture.options, join(fixture.root, 'qa.json')),
    ).toThrow(/reuses output .* for different render content/u);
  });

  it('maps only typed, quality-checked cue progress', () => {
    expect(
      qwenProgressFromMessage({
        type: 'qwen-progress',
        operation: 'render',
        stage: 'quality-checked',
        cueId: 'question-1',
        completed: 1,
        total: 2,
      }),
    ).toEqual({
      type: 'progress',
      cueId: 'question-1',
      cached: false,
    });
    expect(
      qwenProgressFromMessage({
        type: 'qwen-stage',
        stage: 'base-voice-clone',
        cueId: 'question-1',
      }),
    ).toBeNull();
  });

  it('maps retry telemetry to safe, non-counting activity without exposing cue diagnostics', () => {
    expect(
      qwenProgressFromMessage({
        type: 'qwen-retry',
        operation: 'render',
        stage: 'quality-retry',
        cueId: 'private-cue-id',
        attempt: 2,
        maximumAttempts: 3,
        seed: 1_234_567,
        reason: 'private transcript QA details',
      }),
    ).toEqual({
      type: 'activity',
      activity: {
        type: 'quality-retry',
        attempt: 2,
        maximumAttempts: 3,
      },
    });
    expect(
      qwenProgressFromMessage({
        type: 'qwen-retry',
        operation: 'render',
        stage: 'quality-retry',
        cueId: 'private-cue-id',
        attempt: 4,
        maximumAttempts: 3,
        seed: 1_234_567,
        reason: 'invalid attempt',
      }),
    ).toBeNull();
  });

  it('normalizes deferred rescue telemetry without leaking worker internals', () => {
    const updates = [
      qwenProgressFromMessage({
        type: 'qwen-deferred',
        operation: 'render',
        stage: 'quality-deferred',
        cueId: 'secret-deferred-cue',
        parkedCount: 1,
        attempt: 1,
        maximumAttempts: 9,
        profile: 'internal-baseline-profile',
        reason: 'private deferred transcript diagnostics',
      }),
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'started',
        parkedCount: 1,
        rescueTotal: 8,
        maximumAttempts: 9,
      }),
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'attempt',
        cueId: 'secret-deferred-cue',
        rescueIndex: 1,
        rescueTotal: 8,
        attempt: 2,
        maximumAttempts: 9,
        profile: 'internal-rescue-profile',
        seed: 987_654_321,
        reason: 'private rescue transcript diagnostics',
      }),
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'recovered',
        cueId: 'secret-deferred-cue',
        attempt: 2,
        profile: 'internal-rescue-profile',
        remainingParked: 0,
      }),
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'exhausted',
        cueId: 'secret-exhausted-cue',
        attempts: 8,
        lastReason: 'private final transcript diagnostics',
      }),
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'complete',
        recoveredCount: 1,
        failedCount: 0,
      }),
    ];

    expect(updates).toEqual([
      {
        type: 'activity',
        activity: { type: 'quality-deferred', parkedCount: 1 },
      },
      {
        type: 'activity',
        activity: {
          type: 'quality-rescue-started',
          parkedCount: 1,
          rescueTotal: 8,
          maximumAttempts: 9,
        },
      },
      {
        type: 'activity',
        activity: {
          type: 'quality-rescue-attempt',
          rescueIndex: 1,
          rescueTotal: 8,
          attempt: 2,
          maximumAttempts: 9,
        },
      },
      {
        type: 'activity',
        activity: { type: 'quality-rescue-recovered', remainingParked: 0 },
      },
      {
        type: 'activity',
        activity: { type: 'quality-rescue-exhausted', attempts: 8 },
      },
      {
        type: 'activity',
        activity: {
          type: 'quality-rescue-complete',
          recoveredCount: 1,
          failedCount: 0,
        },
      },
    ]);
    const publicActivity = JSON.stringify(updates);
    expect(publicActivity).not.toMatch(
      /secret-|internal-|987654321|private .*diagnostics|profile|seed|reason/iu,
    );
  });

  it('finishes rescue against the parked cue count, not the number of rescue passes', () => {
    expect(
      qwenRescueCompletionMatches(1, 1, 0, {
        recoveredCount: 1,
        failedCount: 0,
      }),
    ).toBe(true);
    expect(
      qwenRescueCompletionMatches(2, 1, 1, {
        recoveredCount: 1,
        failedCount: 1,
      }),
    ).toBe(true);
    expect(
      qwenRescueCompletionMatches(2, 1, 0, {
        recoveredCount: 1,
        failedCount: 0,
      }),
    ).toBe(false);
  });

  it('rejects malformed or extended rescue protocol messages', () => {
    expect(
      qwenProgressFromMessage({
        type: 'qwen-rescue',
        operation: 'render',
        stage: 'attempt',
        cueId: 'question-1',
        rescueIndex: 2,
        rescueTotal: 8,
        attempt: 2,
        maximumAttempts: 9,
        profile: 'rescue-profile',
        seed: 123,
        reason: 'quality mismatch',
      }),
    ).toBeNull();
    expect(
      qwenProgressFromMessage({
        type: 'qwen-deferred',
        operation: 'render',
        stage: 'quality-deferred',
        cueId: 'question-1',
        parkedCount: 1,
        attempt: 3,
        maximumAttempts: 3,
        profile: 'baseline',
        reason: 'quality mismatch',
        extraPrivateField: 'must not be accepted',
      }),
    ).toBeNull();
  });

  it('requires every runtime path explicitly from the environment', async () => {
    const fixture = await qwenFixture();
    const environment: NodeJS.ProcessEnv = {
      YAW_VOICE_WORKER_PATH: fixture.workerPath,
      YAW_QWEN_PYTHON_PATH: fixture.pythonPath,
      YAW_QWEN_BASE_MODEL_PATH: fixture.options.baseModelPath,
      YAW_QWEN_ASR_MODEL_PATH: fixture.options.asrModelPath,
      YAW_QWEN_APPROVAL_PATH: fixture.options.approvalPath,
      YAW_QWEN_RUNTIME_MANIFEST_PATH: fixture.options.runtimeManifestPath,
    };
    const adapter = await createQwenVoiceAdapterFromEnvironment(environment);
    expect(adapter.workerPath).toBe(resolve(fixture.workerPath));
    expect(adapter.renderer.engineId).toBe('qwen3-tts');
    expect(adapter.runWorker).toBeTypeOf('function');

    delete environment.YAW_QWEN_ASR_MODEL_PATH;
    await expect(createQwenVoiceAdapterFromEnvironment(environment)).rejects.toThrow(
      /explicit YAW_QWEN_ASR_MODEL_PATH/u,
    );
  });
});
