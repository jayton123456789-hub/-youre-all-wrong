import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHATTERBOX_RUNTIME_MANIFEST,
  cleanChatterboxProbeEnvironment,
  deterministicChatterboxEnvironmentPath,
  deterministicChatterboxModelCachePath,
  deterministicChatterboxModelRepositoryPath,
  deterministicChatterboxModelSnapshotPath,
  deterministicChatterboxPythonPath,
  deterministicChatterboxReceiptPath,
  inspectChatterboxRuntime,
} from './chatterbox-runtime.js';

const temporaryDirectories: string[] = [];
const successfulRuntimeProbe = async () => undefined;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yaw-runtime-receipt-'));
  temporaryDirectories.push(root);
  return join(root, "User's Data 世界");
}

function receipt(path: string) {
  return {
    schemaVersion: 1,
    runtime: 'chatterbox',
    installerRevision: CHATTERBOX_RUNTIME_MANIFEST.installerRevision,
    environmentPath: deterministicChatterboxEnvironmentPath(path),
    modelCachePath: deterministicChatterboxModelCachePath(path),
    model: 'turbo',
    modelRevision: CHATTERBOX_RUNTIME_MANIFEST.models.turbo.revision,
    pythonVersion: '3.11.9',
    pythonArchitecture: '64bit',
    chatterboxTtsVersion: CHATTERBOX_RUNTIME_MANIFEST.packages.chatterboxTts,
    torchVersion: `${CHATTERBOX_RUNTIME_MANIFEST.packages.torch}+cu124`,
    torchaudioVersion: `${CHATTERBOX_RUNTIME_MANIFEST.packages.torchaudio}+cu124`,
    torchBackend: 'cu124',
    perthRevision: CHATTERBOX_RUNTIME_MANIFEST.perthRevision,
    healthCheck: 'model-loaded-no-audio',
    installedAtUtc: '2026-07-25T00:00:00.000Z',
  };
}

async function writePath(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function writePinnedModelCache(path: string, model: 'turbo' | 'original'): Promise<void> {
  const revision = CHATTERBOX_RUNTIME_MANIFEST.models[model].revision;
  await Promise.all([
    ...CHATTERBOX_RUNTIME_MANIFEST.models[model].requiredFiles.map((name) =>
      writePath(join(deterministicChatterboxModelSnapshotPath(path, model), name), 'fixture'),
    ),
    writePath(
      join(deterministicChatterboxModelRepositoryPath(path, model), 'refs', 'main'),
      revision,
    ),
  ]);
}

describe('verified per-user Chatterbox runtime', () => {
  it('isolates the non-audio model probe from inherited Python, cache, token, and telemetry state', () => {
    const modelCachePath = 'C:\\verified model cache';
    const environment = cleanChatterboxProbeEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        OTHER_SETTING: 'kept',
        PYTHONPATH: 'C:\\untrusted',
        HF_TOKEN: 'secret',
        HUGGING_FACE_HUB_TOKEN: 'secret',
        CONDA_PREFIX: 'C:\\untrusted-conda',
        XDG_CACHE_HOME: 'C:\\untrusted-cache',
        YAW_CHATTERBOX_MODEL: 'wrong',
      },
      modelCachePath,
    );

    expect(environment).toMatchObject({
      PATH: 'C:\\Windows\\System32',
      OTHER_SETTING: 'kept',
      HF_HOME: join(modelCachePath, 'huggingface'),
      HUGGINGFACE_HUB_CACHE: join(modelCachePath, 'huggingface', 'hub'),
      TORCH_HOME: join(modelCachePath, 'torch'),
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    expect(environment.PYTHONPATH).toBeUndefined();
    expect(environment.HF_TOKEN).toBeUndefined();
    expect(environment.HUGGING_FACE_HUB_TOKEN).toBeUndefined();
    expect(environment.CONDA_PREFIX).toBeUndefined();
    expect(environment.XDG_CACHE_HOME).toBeUndefined();
    expect(environment.YAW_CHATTERBOX_MODEL).toBeUndefined();
  });

  it('accepts only a matching receipt and Python executable at deterministic paths', async () => {
    const path = await userData();
    await Promise.all([
      writePath(deterministicChatterboxPythonPath(path), 'fixture python'),
      writePinnedModelCache(path, 'turbo'),
      writePath(deterministicChatterboxReceiptPath(path), JSON.stringify(receipt(path))),
    ]);

    await expect(
      inspectChatterboxRuntime(path, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'ready',
      environmentPath: deterministicChatterboxEnvironmentPath(path),
      pythonPath: deterministicChatterboxPythonPath(path),
      receipt: {
        model: 'turbo',
        healthCheck: 'model-loaded-no-audio',
      },
    });
  });

  it('distinguishes a missing install from a partial environment', async () => {
    const missing = await userData();
    const partial = await userData();
    await writePath(deterministicChatterboxPythonPath(partial), 'partial python');

    await expect(inspectChatterboxRuntime(missing)).resolves.toMatchObject({
      state: 'missing',
    });
    await expect(inspectChatterboxRuntime(partial)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/receipt is missing/u),
    });
  });

  it.each([
    ['obsolete installer', { installerRevision: 'old-installer' }, /install receipt is invalid/u],
    ['wrong architecture', { pythonArchitecture: '32bit' }, /install receipt is invalid/u],
    [
      'wrong environment',
      { environmentPath: 'C:\\SomeoneElse\\voice-runtime\\chatterbox-venv' },
      /different environment path/u,
    ],
    [
      'wrong model cache',
      { modelCachePath: 'C:\\SomeoneElse\\model-cache' },
      /different model-cache path/u,
    ],
    ['missing health check', { healthCheck: 'imports-only' }, /install receipt is invalid/u],
  ])('rejects a receipt with %s', async (_description, patch, expected) => {
    const path = await userData();
    await Promise.all([
      writePath(deterministicChatterboxPythonPath(path), 'fixture python'),
      writePinnedModelCache(path, 'turbo'),
      writePath(
        deterministicChatterboxReceiptPath(path),
        JSON.stringify({ ...receipt(path), ...patch }),
      ),
    ]);

    await expect(inspectChatterboxRuntime(path)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(expected),
    });
  });

  it('rejects a receipt when its exact pinned model snapshot is absent or points elsewhere', async () => {
    const missingSnapshot = await userData();
    await Promise.all([
      writePath(deterministicChatterboxPythonPath(missingSnapshot), 'fixture python'),
      writePath(
        deterministicChatterboxReceiptPath(missingSnapshot),
        JSON.stringify(receipt(missingSnapshot)),
      ),
    ]);

    await expect(inspectChatterboxRuntime(missingSnapshot)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/model snapshot is incomplete/u),
    });

    const wrongReference = await userData();
    await Promise.all([
      writePath(deterministicChatterboxPythonPath(wrongReference), 'fixture python'),
      writePinnedModelCache(wrongReference, 'turbo'),
      writePath(
        deterministicChatterboxReceiptPath(wrongReference),
        JSON.stringify(receipt(wrongReference)),
      ),
    ]);
    await writePath(
      join(deterministicChatterboxModelRepositoryPath(wrongReference, 'turbo'), 'refs', 'main'),
      '0'.repeat(40),
    );

    await expect(inspectChatterboxRuntime(wrongReference)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/does not match its verified revision/u),
    });
  });

  it('fails closed when a non-audio package probe detects a broken environment', async () => {
    const path = await userData();
    await Promise.all([
      writePath(deterministicChatterboxPythonPath(path), 'fixture python'),
      writePinnedModelCache(path, 'turbo'),
      writePath(deterministicChatterboxReceiptPath(path), JSON.stringify(receipt(path))),
    ]);
    const probe = async () => {
      throw new Error('torch import failed');
    };

    await expect(inspectChatterboxRuntime(path, { probe })).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/package probe failed: torch import failed/u),
    });
  });
});
