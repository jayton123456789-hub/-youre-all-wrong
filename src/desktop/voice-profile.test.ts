import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  QWEN_ASR_REQUIRED_FILES,
  QWEN_BASE_REQUIRED_FILES,
  QWEN_RUNTIME_MANIFEST,
  QWEN_RUNTIME_MANIFEST_SHA256,
  deterministicQwenEnvironmentPath,
  deterministicQwenModelCachePath,
  deterministicQwenModelPath,
  deterministicQwenPythonPath,
  deterministicQwenReceiptPath,
} from './qwen-runtime.js';
import {
  buildRuntimeVoiceEnvironment,
  inspectDesktopVoiceProfile,
  resolveDesktopVoice,
  type ResolveDesktopVoiceOptions,
} from './voice-profile.js';

const temporaryDirectories: string[] = [];
const successfulRuntimeProbe = async () => undefined;
const REFERENCE_TRANSCRIPT =
  "Welcome to You're All Wrong. Tonight, four innocent buttons are about to become evidence.";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeRegularFile(
  path: string,
  contents: Buffer | string = 'fixture',
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function pcmWave(durationMs = 6_000): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = Math.round((durationMs / 1_000) * sampleRate) * blockAlign;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write('RIFF', 0, 'ascii');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVE', 8, 'ascii');
  wave.write('fmt ', 12, 'ascii');
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(channels, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * blockAlign, 28);
  wave.writeUInt16LE(blockAlign, 32);
  wave.writeUInt16LE(bitsPerSample, 34);
  wave.write('data', 36, 'ascii');
  wave.writeUInt32LE(dataBytes, 40);
  return wave;
}

interface TestPaths {
  root: string;
  userData: string;
  projectRoot: string;
  resourcesPath: string;
  persistedProfilePath: string;
  bundledProfilePath: string;
  qwenWorkerPath: string;
  qwenRuntimeManifestPath: string;
  systemWorkerPath: string;
}

async function writeRuntimeModel(userData: string, kind: 'base' | 'asr', names: readonly string[]) {
  const pin = QWEN_RUNTIME_MANIFEST.models[kind];
  const files = [];
  for (const [index, name] of names.entries()) {
    const bytes = Buffer.from(`${kind}:${index}:${name}`, 'utf8');
    await writeRegularFile(
      join(deterministicQwenModelPath(userData, kind), ...name.split('/')),
      bytes,
    );
    files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
  }
  await writeRegularFile(
    join(deterministicQwenModelPath(userData, kind), '.yaw-model.json'),
    JSON.stringify({
      schemaVersion: 2,
      repository: pin.repository,
      revision: pin.revision,
      files,
    }),
  );
  return {
    repository: pin.repository,
    revision: pin.revision,
    path: deterministicQwenModelPath(userData, kind),
    files,
  };
}

async function writeReadyRuntime(userData: string): Promise<void> {
  const [base, asr] = await Promise.all([
    writeRuntimeModel(userData, 'base', QWEN_BASE_REQUIRED_FILES),
    writeRuntimeModel(userData, 'asr', QWEN_ASR_REQUIRED_FILES),
  ]);
  await Promise.all([
    writeRegularFile(deterministicQwenPythonPath(userData)),
    writeRegularFile(
      deterministicQwenReceiptPath(userData),
      JSON.stringify({
        schemaVersion: 2,
        state: 'ready',
        installerRevision: QWEN_RUNTIME_MANIFEST.installerRevision,
        installedAt: '2026-07-26T03:10:16.916Z',
        environmentPath: deterministicQwenEnvironmentPath(userData),
        modelCachePath: deterministicQwenModelCachePath(userData),
        torchBackend: 'cpu',
        runtimeManifestSha256: QWEN_RUNTIME_MANIFEST_SHA256,
        runtime: {
          python: '3.12.10',
          qwenTts: QWEN_RUNTIME_MANIFEST.packages.qwenTts,
          transformers: QWEN_RUNTIME_MANIFEST.packages.transformers,
          accelerate: QWEN_RUNTIME_MANIFEST.packages.accelerate,
          torch: `${QWEN_RUNTIME_MANIFEST.packages.torch}+cpu`,
          torchaudio: `${QWEN_RUNTIME_MANIFEST.packages.torchaudio}+cpu`,
          cudaAvailable: false,
          gpu: null,
        },
        models: { base, asr },
      }),
    ),
  ]);
}

async function testPaths(): Promise<TestPaths> {
  const root = await mkdtemp(join(tmpdir(), 'yaw-qwen-profile-'));
  temporaryDirectories.push(root);
  const userData = join(root, "User's Data 世界");
  const projectRoot = join(root, 'project');
  const resourcesPath = join(root, 'resources');
  const paths = {
    root,
    userData,
    projectRoot,
    resourcesPath,
    persistedProfilePath: join(userData, 'voice', 'active-profile.json'),
    bundledProfilePath: join(resourcesPath, 'host-voice', 'profile.json'),
    qwenWorkerPath: join(resourcesPath, 'qwen-voice-worker.py'),
    qwenRuntimeManifestPath: join(resourcesPath, 'qwen-runtime-manifest.json'),
    systemWorkerPath: join(resourcesPath, 'system-voice-worker.ps1'),
  };
  await Promise.all([
    writeRegularFile(paths.qwenWorkerPath),
    writeRegularFile(
      paths.qwenRuntimeManifestPath,
      await readFile(resolve('services/qwen-runtime-manifest.json')),
    ),
    writeRegularFile(paths.systemWorkerPath),
    writeReadyRuntime(paths.userData),
  ]);
  return paths;
}

function resolveOptions(
  paths: TestPaths,
  overrides: Partial<ResolveDesktopVoiceOptions> = {},
): ResolveDesktopVoiceOptions {
  return {
    environment: {},
    allowDevelopmentOverride: false,
    isPackaged: false,
    projectRoot: paths.projectRoot,
    resourcesPath: paths.resourcesPath,
    userDataDirectory: paths.userData,
    qwenWorkerPath: paths.qwenWorkerPath,
    qwenRuntimeManifestPath: paths.qwenRuntimeManifestPath,
    systemWorkerPath: paths.systemWorkerPath,
    persistedProfilePath: paths.persistedProfilePath,
    bundledProfilePath: paths.bundledProfilePath,
    runtimeProbe: successfulRuntimeProbe,
    ...overrides,
  };
}

async function writeApprovedProfile(
  profilePath: string,
  options: {
    voiceId: string;
    voiceName: string;
    referenceBytes?: Buffer;
    profileSha256?: string;
    approvalSha256?: string;
    approvalTranscript?: string;
    approvalVoiceId?: string;
  },
): Promise<void> {
  const referenceBytes = options.referenceBytes ?? pcmWave();
  const referencePath = join(dirname(profilePath), 'reference.wav');
  const referenceSha256 = sha256(referenceBytes);
  await Promise.all([
    writeRegularFile(referencePath, referenceBytes),
    writeRegularFile(
      profilePath,
      JSON.stringify({
        schemaVersion: 2,
        engine: 'qwen3-tts',
        model: 'base-0.6b',
        voiceId: options.voiceId,
        voiceName: options.voiceName,
        reference: {
          file: 'reference.wav',
          sha256: options.profileSha256 ?? referenceSha256,
          transcript: REFERENCE_TRANSCRIPT,
        },
      }),
    ),
    writeRegularFile(
      join(dirname(profilePath), 'approval.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'approved',
        engine: 'qwen3-tts',
        syntheticOriginal: true,
        voiceId: options.approvalVoiceId ?? options.voiceId,
        voiceName: options.voiceName,
        approvedAt: '2026-07-26T03:10:16.916Z',
        approvedAsRendered: true,
        reference: {
          file: 'reference.wav',
          sha256: options.approvalSha256 ?? referenceSha256,
          transcript: options.approvalTranscript ?? REFERENCE_TRANSCRIPT,
        },
        audition: {
          candidateId: 'qwen-host-02',
          seed: 1_730_324_455,
          transcriptWordErrorRate: 0,
          onsetMilliseconds: 233,
        },
      }),
    ),
  ]);
}

describe('desktop Qwen voice profile resolution', () => {
  it('verifies the checked-in approved Voice 2 package itself', async () => {
    const inspected = await inspectDesktopVoiceProfile(
      resolve('assets/voice/original-host-v1/profile.json'),
      'approved Voice 2',
    );

    expect(inspected).toMatchObject({
      found: true,
      verified: {
        profile: {
          schemaVersion: 2,
          engine: 'qwen3-tts',
          model: 'base-0.6b',
          voiceId: 'original-host-v1',
        },
        approval: {
          status: 'approved',
          audition: { candidateId: 'qwen-host-02' },
        },
        referenceSha256: '1cd786f2cf9c15bf66e116ca46dd391d58a3d812843f290229aebbec6014efdd',
      },
    });
  });

  it('prefers a fully verified persisted approval over the bundled host', async () => {
    const paths = await testPaths();
    await writeApprovedProfile(paths.persistedProfilePath, {
      voiceId: 'approved-host-v2',
      voiceName: 'Approved Host V2',
    });
    await writeApprovedProfile(paths.bundledProfilePath, {
      voiceId: 'bundled-host-v1',
      voiceName: 'Bundled Host V1',
    });

    const selected = await resolveDesktopVoice(resolveOptions(paths));

    expect(selected).toMatchObject({
      kind: 'qwen3-tts',
      source: 'persisted',
      profile: {
        voiceId: 'approved-host-v2',
        voiceName: 'Approved Host V2',
        model: 'base-0.6b',
      },
      approval: {
        status: 'approved',
        syntheticOriginal: true,
      },
      approvalPath: join(dirname(paths.persistedProfilePath), 'approval.json'),
      pythonPath: deterministicQwenPythonPath(paths.userData),
      baseModelPath: deterministicQwenModelPath(paths.userData, 'base'),
      asrModelPath: deterministicQwenModelPath(paths.userData, 'asr'),
      workerPath: paths.qwenWorkerPath,
      runtimeManifestPath: paths.qwenRuntimeManifestPath,
      device: 'cpu',
    });
  });

  it('uses the verified bundled host when no persisted profile exists', async () => {
    const paths = await testPaths();
    await writeApprovedProfile(paths.bundledProfilePath, {
      voiceId: 'bundled-host-v1',
      voiceName: 'Bundled Host V1',
    });

    await expect(resolveDesktopVoice(resolveOptions(paths))).resolves.toMatchObject({
      kind: 'qwen3-tts',
      source: 'bundled',
      profile: { voiceId: 'bundled-host-v1' },
      baseModelRevision: QWEN_RUNTIME_MANIFEST.models.base.revision,
      asrModelRevision: QWEN_RUNTIME_MANIFEST.models.asr.revision,
    });
  });

  it.each([
    {
      problem: 'an altered profile reference hash',
      mutate: async (path: string) =>
        writeApprovedProfile(path, {
          voiceId: 'tampered-host',
          voiceName: 'Tampered Host',
          profileSha256: '0'.repeat(64),
        }),
      expected: /different voice identities/u,
    },
    {
      problem: 'an altered approval reference hash',
      mutate: async (path: string) =>
        writeApprovedProfile(path, {
          voiceId: 'tampered-host',
          voiceName: 'Tampered Host',
          approvalSha256: '0'.repeat(64),
        }),
      expected: /different voice identities/u,
    },
    {
      problem: 'a mismatched approval transcript',
      mutate: async (path: string) =>
        writeApprovedProfile(path, {
          voiceId: 'tampered-host',
          voiceName: 'Tampered Host',
          approvalTranscript: 'A different performance.',
        }),
      expected: /different voice identities/u,
    },
    {
      problem: 'a mismatched approval voice ID',
      mutate: async (path: string) =>
        writeApprovedProfile(path, {
          voiceId: 'tampered-host',
          approvalVoiceId: 'other-host',
          voiceName: 'Tampered Host',
        }),
      expected: /different voice identities/u,
    },
  ])(
    'fails closed on $problem instead of silently using the bundled voice',
    async ({ mutate, expected }) => {
      const paths = await testPaths();
      await mutate(paths.persistedProfilePath);
      await writeApprovedProfile(paths.bundledProfilePath, {
        voiceId: 'bundled-host-v1',
        voiceName: 'Bundled Host V1',
      });

      const selected = await resolveDesktopVoice(resolveOptions(paths));

      expect(selected.kind).toBe('unavailable');
      if (selected.kind === 'unavailable') expect(selected.message).toMatch(expected);
    },
  );

  it('fails closed when approval.json is missing even if the profile and WAV are intact', async () => {
    const paths = await testPaths();
    await writeApprovedProfile(paths.persistedProfilePath, {
      voiceId: 'approved-host',
      voiceName: 'Approved Host',
    });
    await rm(join(dirname(paths.persistedProfilePath), 'approval.json'));

    await expect(resolveDesktopVoice(resolveOptions(paths))).resolves.toMatchObject({
      kind: 'unavailable',
      message: expect.stringMatching(/approval could not be verified/u),
    });
  });

  it('allows Qwen and System.Speech only as explicit unpackaged development overrides', async () => {
    const paths = await testPaths();
    const developmentProfile = join(paths.root, 'auditions', 'profile.json');
    await writeApprovedProfile(developmentProfile, {
      voiceId: 'audition-winner',
      voiceName: 'Audition Winner',
    });
    await writeApprovedProfile(paths.persistedProfilePath, {
      voiceId: 'persisted-host',
      voiceName: 'Persisted Host',
    });

    const qwen = await resolveDesktopVoice(
      resolveOptions(paths, {
        allowDevelopmentOverride: true,
        environment: {
          YAW_VOICE_ENGINE: 'qwen3-tts',
          YAW_QWEN_PROFILE_PATH: developmentProfile,
        },
      }),
    );
    const system = await resolveDesktopVoice(
      resolveOptions(paths, {
        allowDevelopmentOverride: true,
        environment: { YAW_VOICE_ENGINE: 'system-speech' },
      }),
    );
    const packaged = await resolveDesktopVoice(
      resolveOptions(paths, {
        allowDevelopmentOverride: false,
        environment: { YAW_VOICE_ENGINE: 'system-speech' },
      }),
    );

    expect(qwen).toMatchObject({
      kind: 'qwen3-tts',
      source: 'development',
      profile: { voiceId: 'audition-winner' },
    });
    expect(system).toEqual({
      kind: 'system-speech',
      source: 'development',
      workerPath: paths.systemWorkerPath,
    });
    expect(packaged).toMatchObject({
      kind: 'qwen3-tts',
      source: 'persisted',
    });
  });

  it('builds a clean offline child environment from only the verified selection', async () => {
    const paths = await testPaths();
    await writeApprovedProfile(paths.persistedProfilePath, {
      voiceId: 'clean-host',
      voiceName: 'Clean Host',
    });
    const selected = await resolveDesktopVoice(resolveOptions(paths));
    if (selected.kind !== 'qwen3-tts') {
      throw new Error(`Expected a Qwen fixture, received ${selected.kind}.`);
    }

    const environment = buildRuntimeVoiceEnvironment({
      inheritedEnvironment: {
        PATH: 'C:\\Windows\\System32',
        OTHER_SETTING: 'preserved',
        YAW_QWEN_BASE_MODEL_PATH: 'C:\\unsafe\\stale',
        YAW_CHATTERBOX_REFERENCE: 'C:\\unsafe\\stale.wav',
        YAW_VOICE_ENGINE: 'system-speech',
        HF_HOME: 'C:\\unsafe\\huggingface',
        PYTHONPATH: 'C:\\unsafe\\python',
        PIP_INDEX_URL: 'https://unsafe.invalid',
        TORCH_HOME: 'C:\\unsafe\\torch',
        VIRTUAL_ENV: 'C:\\unsafe\\venv',
        yAw_VoIcE_WoRkEr_PaTh: 'C:\\unsafe\\worker.ps1',
      },
      selection: selected,
      voiceCachePath: join(paths.userData, 'voice-cache'),
    });

    expect(environment).toMatchObject({
      PATH: 'C:\\Windows\\System32',
      OTHER_SETTING: 'preserved',
      YAW_VOICE_ENGINE: 'qwen3-tts',
      YAW_VOICE_WORKER_PATH: paths.qwenWorkerPath,
      YAW_QWEN_PYTHON_PATH: deterministicQwenPythonPath(paths.userData),
      YAW_QWEN_BASE_MODEL_PATH: deterministicQwenModelPath(paths.userData, 'base'),
      YAW_QWEN_ASR_MODEL_PATH: deterministicQwenModelPath(paths.userData, 'asr'),
      YAW_QWEN_APPROVAL_PATH: join(dirname(paths.persistedProfilePath), 'approval.json'),
      YAW_QWEN_RUNTIME_MANIFEST_PATH: paths.qwenRuntimeManifestPath,
      YAW_VOICE_CACHE_PATH: resolve(paths.userData, 'voice-cache'),
      HF_HOME: join(deterministicQwenModelCachePath(paths.userData), 'huggingface'),
      HUGGINGFACE_HUB_CACHE: join(
        deterministicQwenModelCachePath(paths.userData),
        'huggingface',
        'hub',
      ),
      TORCH_HOME: join(deterministicQwenModelCachePath(paths.userData), 'torch'),
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONNOUSERSITE: '1',
      CUBLAS_WORKSPACE_CONFIG: ':4096:8',
    });
    expect(environment.YAW_CHATTERBOX_REFERENCE).toBeUndefined();
    expect(environment.yAw_VoIcE_WoRkEr_PaTh).toBeUndefined();
    expect(environment.PYTHONPATH).toBeUndefined();
    expect(environment.PIP_INDEX_URL).toBeUndefined();
    expect(environment.VIRTUAL_ENV).toBeUndefined();
    expect(
      Object.keys(environment).filter(
        (key) =>
          key.toUpperCase().startsWith('YAW_VOICE_') || key.toUpperCase().startsWith('YAW_QWEN_'),
      ),
    ).toEqual([
      'YAW_VOICE_CACHE_PATH',
      'YAW_VOICE_ENGINE',
      'YAW_VOICE_WORKER_PATH',
      'YAW_QWEN_PYTHON_PATH',
      'YAW_QWEN_BASE_MODEL_PATH',
      'YAW_QWEN_ASR_MODEL_PATH',
      'YAW_QWEN_APPROVAL_PATH',
      'YAW_QWEN_RUNTIME_MANIFEST_PATH',
    ]);
  });

  it('passes an unavailable message without leaking stale engine switches', () => {
    const environment = buildRuntimeVoiceEnvironment({
      inheritedEnvironment: {
        YAW_VOICE_ENGINE: 'system-speech',
        YAW_QWEN_BASE_MODEL_PATH: 'C:\\unsafe',
        YAW_CHATTERBOX_ALLOW_DEFAULT: '1',
      },
      selection: {
        kind: 'unavailable',
        message: 'Approve and install Voice 2 first.',
      },
      voiceCachePath: 'C:\\voice-cache',
    });

    expect(environment).toMatchObject({
      YAW_VOICE_ENGINE: 'unavailable',
      YAW_VOICE_UNAVAILABLE_MESSAGE: 'Approve and install Voice 2 first.',
    });
    expect(environment.YAW_QWEN_BASE_MODEL_PATH).toBeUndefined();
    expect(environment.YAW_CHATTERBOX_ALLOW_DEFAULT).toBeUndefined();
    expect(environment.YAW_VOICE_WORKER_PATH).toBeUndefined();
  });
});
