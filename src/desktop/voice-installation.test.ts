import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  activateBundledDesktopVoiceProfile,
  bootstrapDesktopVoice,
  inspectDesktopVoiceBootstrap,
  type DesktopVoiceBootstrapOptions,
  type QwenInstallerRunner,
} from './voice-installation.js';
import { inspectDesktopVoiceProfile, persistedDesktopVoiceProfilePath } from './voice-profile.js';

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

interface Fixture {
  root: string;
  userDataDirectory: string;
  bundledProfilePath: string;
  setupScriptPath: string;
  runtimeManifestPath: string;
  qwenWorkerPath: string;
}

async function writeFixtureFile(
  path: string,
  contents: string | Buffer = 'fixture',
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'yaw-qwen-installation-'));
  temporaryDirectories.push(root);
  const specialRoot = join(root, "Jay's Voice 世界");
  const resources = join(specialRoot, 'resources');
  const paths = {
    root: specialRoot,
    userDataDirectory: join(specialRoot, 'user data'),
    bundledProfilePath: join(resources, 'host-voice', 'profile.json'),
    setupScriptPath: join(resources, 'setup-qwen-tts.ps1'),
    runtimeManifestPath: join(resources, 'qwen-runtime-manifest.json'),
    qwenWorkerPath: join(resources, 'qwen-voice-worker.py'),
  };
  await Promise.all([
    writeFixtureFile(paths.setupScriptPath),
    writeFixtureFile(paths.runtimeManifestPath),
    writeFixtureFile(paths.qwenWorkerPath),
  ]);
  return paths;
}

async function writeBundledProfile(
  paths: Fixture,
  overrides: {
    voiceName?: string;
    transcript?: string;
  } = {},
): Promise<{ approvalText: string; reference: Buffer }> {
  const reference = pcmWave();
  const referenceSha256 = sha256(reference);
  const directory = dirname(paths.bundledProfilePath);
  const transcript = overrides.transcript ?? REFERENCE_TRANSCRIPT;
  const voiceName = overrides.voiceName ?? 'The Host';
  const approvalText = `${JSON.stringify(
    {
      schemaVersion: 1,
      status: 'approved',
      engine: 'qwen3-tts',
      syntheticOriginal: true,
      voiceId: 'original-host-v1',
      voiceName,
      approvedAt: '2026-07-26T03:10:16.916Z',
      approvedAsRendered: true,
      reference: {
        file: 'reference.wav',
        sha256: referenceSha256,
        transcript,
      },
      audition: {
        candidateId: 'qwen-host-02',
        seed: 1_730_324_455,
        transcriptWordErrorRate: 0,
        onsetMilliseconds: 233,
      },
    },
    null,
    4,
  )}\n`;
  await Promise.all([
    writeFixtureFile(join(directory, 'reference.wav'), reference),
    writeFixtureFile(
      paths.bundledProfilePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          engine: 'qwen3-tts',
          model: 'base-0.6b',
          voiceId: 'original-host-v1',
          voiceName,
          reference: {
            file: 'reference.wav',
            sha256: referenceSha256,
            transcript,
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFixtureFile(join(directory, 'approval.json'), approvalText),
  ]);
  return { approvalText, reference };
}

async function writeRuntimeModel(
  paths: Fixture,
  kind: 'base' | 'asr',
  requiredFiles: readonly string[],
) {
  const pin = QWEN_RUNTIME_MANIFEST.models[kind];
  const modelPath = deterministicQwenModelPath(paths.userDataDirectory, kind);
  const files = [];
  for (const [index, name] of requiredFiles.entries()) {
    const bytes = Buffer.from(`${kind}:${index}:${name}`, 'utf8');
    await writeFixtureFile(join(modelPath, ...name.split('/')), bytes);
    files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
  }
  await writeFixtureFile(
    join(modelPath, '.yaw-model.json'),
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
    path: modelPath,
    files,
  };
}

async function writeRuntime(paths: Fixture): Promise<void> {
  const [base, asr] = await Promise.all([
    writeRuntimeModel(paths, 'base', QWEN_BASE_REQUIRED_FILES),
    writeRuntimeModel(paths, 'asr', QWEN_ASR_REQUIRED_FILES),
  ]);
  await Promise.all([
    writeFixtureFile(deterministicQwenPythonPath(paths.userDataDirectory)),
    writeFixtureFile(
      deterministicQwenReceiptPath(paths.userDataDirectory),
      JSON.stringify({
        schemaVersion: 2,
        state: 'ready',
        installerRevision: QWEN_RUNTIME_MANIFEST.installerRevision,
        installedAt: '2026-07-26T03:10:16.916Z',
        environmentPath: deterministicQwenEnvironmentPath(paths.userDataDirectory),
        modelCachePath: deterministicQwenModelCachePath(paths.userDataDirectory),
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

function options(
  paths: Fixture,
  overrides: Partial<DesktopVoiceBootstrapOptions> = {},
): DesktopVoiceBootstrapOptions {
  return {
    userDataDirectory: paths.userDataDirectory,
    bundledProfilePath: paths.bundledProfilePath,
    setupScriptPath: paths.setupScriptPath,
    runtimeManifestPath: paths.runtimeManifestPath,
    qwenWorkerPath: paths.qwenWorkerPath,
    runtimeProbe: successfulRuntimeProbe,
    inheritedEnvironment: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      YAW_VOICE_ENGINE: 'unsafe',
      YAW_QWEN_BASE_MODEL_PATH: 'C:\\unsafe\\base',
      PYTHONPATH: 'C:\\unsafe',
      PIP_INDEX_URL: 'https://unsafe.invalid',
      HF_HOME: 'C:\\unsafe\\huggingface',
    },
    ...overrides,
  };
}

describe('desktop Qwen neural-host bootstrap', () => {
  it('does not run an installer while the approved bundled profile is absent', async () => {
    const paths = await fixture();
    const runInstaller = vi.fn<QwenInstallerRunner>();

    await expect(inspectDesktopVoiceBootstrap(options(paths))).resolves.toMatchObject({
      state: 'awaiting-profile',
    });
    await expect(bootstrapDesktopVoice(options(paths, { runInstaller }))).resolves.toMatchObject({
      ok: false,
      code: 'profile_missing',
    });
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it('installs once into exact per-user paths and activates the approved package unchanged', async () => {
    const paths = await fixture();
    const bundle = await writeBundledProfile(paths);
    const progress: string[] = [];
    const runInstaller = vi.fn<QwenInstallerRunner>(async (invocation, runnerOptions) => {
      expect(invocation).toEqual({
        setupScriptPath: paths.setupScriptPath,
        runtimeManifestPath: paths.runtimeManifestPath,
        environmentPath: deterministicQwenEnvironmentPath(paths.userDataDirectory),
        modelCachePath: deterministicQwenModelCachePath(paths.userDataDirectory),
        torchBackend: 'auto',
      });
      expect(invocation).not.toHaveProperty('model');
      expect(runnerOptions.environment).toMatchObject({
        PATH: 'C:\\Windows\\System32',
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
      });
      expect(runnerOptions.environment.YAW_VOICE_ENGINE).toBeUndefined();
      expect(runnerOptions.environment.YAW_QWEN_BASE_MODEL_PATH).toBeUndefined();
      expect(runnerOptions.environment.PYTHONPATH).toBeUndefined();
      expect(runnerOptions.environment.PIP_INDEX_URL).toBeUndefined();
      expect(runnerOptions.environment.HF_HOME).toBeUndefined();
      runnerOptions.onOutput?.('Pinned Qwen model health check passed.');
      await writeRuntime(paths);
    });
    const bootstrapOptions = options(paths, {
      runInstaller,
      onProgress: ({ message }) => progress.push(message),
    });

    await expect(inspectDesktopVoiceBootstrap(bootstrapOptions)).resolves.toMatchObject({
      state: 'installable',
      model: 'base-0.6b',
      environmentPath: deterministicQwenEnvironmentPath(paths.userDataDirectory),
    });
    const first = bootstrapDesktopVoice(bootstrapOptions);
    const concurrent = bootstrapDesktopVoice(bootstrapOptions);
    expect(concurrent).toBe(first);
    const result = await first;

    expect(result).toMatchObject({
      ok: true,
      state: {
        state: 'ready',
        voiceName: 'The Host',
        model: 'base-0.6b',
      },
    });
    expect(runInstaller).toHaveBeenCalledOnce();
    expect(progress).toContain('Pinned Qwen model health check passed.');

    const activeProfilePath = persistedDesktopVoiceProfilePath(paths.userDataDirectory);
    const activeDirectory = dirname(activeProfilePath);
    const active = await inspectDesktopVoiceProfile(activeProfilePath, 'persisted');
    expect(active).toMatchObject({
      found: true,
      verified: {
        profile: {
          voiceId: 'original-host-v1',
          voiceName: 'The Host',
          reference: {
            file: expect.stringMatching(/^references\/[a-f0-9]{64}\.wav$/u),
            transcript: REFERENCE_TRANSCRIPT,
          },
        },
        approval: {
          status: 'approved',
          reference: {
            file: 'reference.wav',
            transcript: REFERENCE_TRANSCRIPT,
          },
        },
      },
    });
    await expect(readFile(join(activeDirectory, 'approval.json'), 'utf8')).resolves.toBe(
      bundle.approvalText,
    );
    expect(sha256(await readFile(join(activeDirectory, 'reference.wav')))).toBe(
      sha256(bundle.reference),
    );
    await expect(inspectDesktopVoiceBootstrap(bootstrapOptions)).resolves.toMatchObject({
      state: 'ready',
    });
  });

  it('skips setup when the exact Qwen runtime is ready and only activates the host package', async () => {
    const paths = await fixture();
    await Promise.all([writeBundledProfile(paths), writeRuntime(paths)]);
    const runInstaller = vi.fn<QwenInstallerRunner>(async () => {
      throw new Error('A verified Qwen runtime must not be reinstalled.');
    });

    const result = await bootstrapDesktopVoice(options(paths, { runInstaller }));

    expect(result.ok).toBe(true);
    expect(runInstaller).not.toHaveBeenCalled();
    await expect(
      readFile(persistedDesktopVoiceProfilePath(paths.userDataDirectory), 'utf8'),
    ).resolves.toContain('"voiceName": "The Host"');
  });

  it('reactivates the bundle when the persisted approval identity is stale', async () => {
    const paths = await fixture();
    await Promise.all([writeBundledProfile(paths), writeRuntime(paths)]);
    const bundled = await inspectDesktopVoiceProfile(paths.bundledProfilePath, 'bundled');
    if (!bundled.found || 'error' in bundled) throw new Error('Invalid bundled test profile.');
    const profilePath = await activateBundledDesktopVoiceProfile(
      paths.userDataDirectory,
      bundled.verified,
    );
    const approvalPath = join(dirname(profilePath), 'approval.json');
    const staleApproval = JSON.parse(await readFile(approvalPath, 'utf8')) as {
      voiceName: string;
    };
    staleApproval.voiceName = 'Stale Host Name';
    await writeFixtureFile(approvalPath, JSON.stringify(staleApproval));
    const runInstaller = vi.fn<QwenInstallerRunner>();
    const bootstrapOptions = options(paths, { runInstaller });

    await expect(inspectDesktopVoiceBootstrap(bootstrapOptions)).resolves.toMatchObject({
      state: 'repairable',
      message: expect.stringMatching(/profile still needs activation/u),
    });
    await expect(bootstrapDesktopVoice(bootstrapOptions)).resolves.toMatchObject({ ok: true });
    expect(runInstaller).not.toHaveBeenCalled();
    await expect(readFile(approvalPath, 'utf8')).resolves.toBe(
      await readFile(join(dirname(paths.bundledProfilePath), 'approval.json'), 'utf8'),
    );
  });

  it('repairs an invalid Qwen receipt before activating the profile', async () => {
    const paths = await fixture();
    await Promise.all([writeBundledProfile(paths), writeRuntime(paths)]);
    await writeFixtureFile(deterministicQwenReceiptPath(paths.userDataDirectory), '{}');
    const runInstaller = vi.fn<QwenInstallerRunner>(async () => writeRuntime(paths));
    const bootstrapOptions = options(paths, { runInstaller });

    await expect(inspectDesktopVoiceBootstrap(bootstrapOptions)).resolves.toMatchObject({
      state: 'repairable',
      message: expect.stringMatching(/receipt is invalid/u),
    });
    await expect(bootstrapDesktopVoice(bootstrapOptions)).resolves.toMatchObject({ ok: true });
    expect(runInstaller).toHaveBeenCalledOnce();
  });

  it('preserves the current active package when runtime installation fails', async () => {
    const paths = await fixture();
    await writeBundledProfile(paths);
    const activeDirectory = dirname(persistedDesktopVoiceProfilePath(paths.userDataDirectory));
    const currentProfile = '{"current":"profile stays intact"}\n';
    const currentApproval = '{"current":"approval stays intact"}\n';
    await Promise.all([
      writeFixtureFile(persistedDesktopVoiceProfilePath(paths.userDataDirectory), currentProfile),
      writeFixtureFile(join(activeDirectory, 'approval.json'), currentApproval),
    ]);
    const runInstaller = vi.fn<QwenInstallerRunner>(async () => {
      throw new Error('simulated download failure');
    });

    const result = await bootstrapDesktopVoice(options(paths, { runInstaller }));

    expect(result).toMatchObject({
      ok: false,
      code: 'installer_failed',
      message: 'simulated download failure',
    });
    await expect(
      readFile(persistedDesktopVoiceProfilePath(paths.userDataDirectory), 'utf8'),
    ).resolves.toBe(currentProfile);
    await expect(readFile(join(activeDirectory, 'approval.json'), 'utf8')).resolves.toBe(
      currentApproval,
    );
  });

  it('preserves the active package when the post-install Qwen probe fails', async () => {
    const paths = await fixture();
    await writeBundledProfile(paths);
    const activeProfilePath = persistedDesktopVoiceProfilePath(paths.userDataDirectory);
    const currentProfile = '{"current":"profile stays intact"}\n';
    await writeFixtureFile(activeProfilePath, currentProfile);
    const runInstaller = vi.fn<QwenInstallerRunner>(async () => writeRuntime(paths));
    const runtimeProbe = async () => {
      throw new Error('pinned Qwen model failed to load');
    };

    const result = await bootstrapDesktopVoice(options(paths, { runInstaller, runtimeProbe }));

    expect(result).toMatchObject({
      ok: false,
      code: 'runtime_invalid',
      message: expect.stringMatching(/pinned Qwen model failed to load/u),
    });
    await expect(readFile(activeProfilePath, 'utf8')).resolves.toBe(currentProfile);
  });

  it('reports cancellation and never activates Voice 2', async () => {
    const paths = await fixture();
    await writeBundledProfile(paths);
    const controller = new AbortController();
    controller.abort();
    const runInstaller = vi.fn<QwenInstallerRunner>(async () => {
      throw new Error('cancelled');
    });

    const result = await bootstrapDesktopVoice(
      options(paths, { runInstaller, signal: controller.signal }),
    );

    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    await expect(
      readFile(persistedDesktopVoiceProfilePath(paths.userDataDirectory), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before installation when any trusted Qwen resource check fails', async () => {
    const paths = await fixture();
    await writeBundledProfile(paths);
    const runInstaller = vi.fn<QwenInstallerRunner>();
    const verifyResource = vi.fn(async (path: string) => {
      if (path === paths.qwenWorkerPath) {
        throw new Error('Qwen worker hash mismatch.');
      }
    });

    const result = await bootstrapDesktopVoice(options(paths, { runInstaller, verifyResource }));

    expect(result).toMatchObject({
      ok: false,
      code: 'resource_invalid',
      message: 'Qwen worker hash mismatch.',
    });
    expect(verifyResource).toHaveBeenCalledTimes(3);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it('repairs both approved WAV destinations and retains the transcript and approval bytes', async () => {
    const paths = await fixture();
    const bundle = await writeBundledProfile(paths, {
      transcript:
        "Welcome to You're All Wrong. The exact approved transcript must survive activation.",
    });
    const inspected = await inspectDesktopVoiceProfile(paths.bundledProfilePath, 'bundled');
    if (!inspected.found || 'error' in inspected) throw new Error('Invalid test voice bundle.');
    const activeProfilePath = persistedDesktopVoiceProfilePath(paths.userDataDirectory);
    const activeDirectory = dirname(activeProfilePath);
    const contentReferencePath = join(
      activeDirectory,
      'references',
      `${inspected.verified.referenceSha256}.wav`,
    );
    await Promise.all([
      writeFixtureFile(activeProfilePath, '{"previous":"active"}\n'),
      writeFixtureFile(join(activeDirectory, 'approval.json'), '{"damaged":true}\n'),
      writeFixtureFile(join(activeDirectory, 'reference.wav'), 'damaged approval reference'),
      writeFixtureFile(contentReferencePath, 'damaged content reference'),
    ]);

    await expect(
      activateBundledDesktopVoiceProfile(paths.userDataDirectory, inspected.verified),
    ).resolves.toBe(activeProfilePath);

    const activeProfile = JSON.parse(await readFile(activeProfilePath, 'utf8')) as {
      reference: { file: string; sha256: string; transcript: string };
    };
    expect(activeProfile.reference).toEqual({
      file: `references/${inspected.verified.referenceSha256}.wav`,
      sha256: inspected.verified.referenceSha256,
      transcript:
        "Welcome to You're All Wrong. The exact approved transcript must survive activation.",
    });
    await expect(readFile(join(activeDirectory, 'approval.json'), 'utf8')).resolves.toBe(
      bundle.approvalText,
    );
    expect(sha256(await readFile(join(activeDirectory, 'reference.wav')))).toBe(
      inspected.verified.referenceSha256,
    );
    expect(sha256(await readFile(contentReferencePath))).toBe(inspected.verified.referenceSha256);
    await expect(inspectDesktopVoiceProfile(activeProfilePath, 'active')).resolves.toMatchObject({
      found: true,
      verified: {
        approvalSha256: inspected.verified.approvalSha256,
        referenceSha256: inspected.verified.referenceSha256,
      },
    });
    const installedFiles = await readdir(activeDirectory, { recursive: true });
    expect(installedFiles.some((file) => file.endsWith('.tmp'))).toBe(false);
    expect(installedFiles.some((file) => file.includes('.backup'))).toBe(false);
  });

  it('leaves an existing activation untouched when the bundled approval changes mid-flight', async () => {
    const paths = await fixture();
    await writeBundledProfile(paths);
    const inspected = await inspectDesktopVoiceProfile(paths.bundledProfilePath, 'bundled');
    if (!inspected.found || 'error' in inspected) throw new Error('Invalid test voice bundle.');
    const activeProfilePath = persistedDesktopVoiceProfilePath(paths.userDataDirectory);
    const activeDirectory = dirname(activeProfilePath);
    const previousProfile = '{"previous":"profile"}\n';
    const previousApproval = '{"previous":"approval"}\n';
    await Promise.all([
      writeFixtureFile(activeProfilePath, previousProfile),
      writeFixtureFile(join(activeDirectory, 'approval.json'), previousApproval),
      writeFixtureFile(inspected.verified.approvalPath, '{"tampered":true}\n'),
    ]);

    await expect(
      activateBundledDesktopVoiceProfile(paths.userDataDirectory, inspected.verified),
    ).rejects.toThrow(/approved host record changed/u);
    await expect(readFile(activeProfilePath, 'utf8')).resolves.toBe(previousProfile);
    await expect(readFile(join(activeDirectory, 'approval.json'), 'utf8')).resolves.toBe(
      previousApproval,
    );
  });
});
