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
  QWEN_VOICE_DESIGN_REQUIRED_FILES,
  cleanQwenProbeEnvironment,
  deterministicQwenEnvironmentPath,
  deterministicQwenModelCachePath,
  deterministicQwenModelPath,
  deterministicQwenPythonPath,
  deterministicQwenReceiptPath,
  inspectQwenRuntime,
  type QwenRuntimeModelKind,
} from './qwen-runtime.js';

const temporaryDirectories: string[] = [];
const successfulRuntimeProbe = async () => undefined;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yaw-qwen-runtime-'));
  temporaryDirectories.push(root);
  return join(root, "User's Data 世界");
}

async function writePath(path: string, contents: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function requiredFiles(kind: QwenRuntimeModelKind): readonly string[] {
  if (kind === 'asr') return QWEN_ASR_REQUIRED_FILES;
  if (kind === 'voiceDesign') return QWEN_VOICE_DESIGN_REQUIRED_FILES;
  return QWEN_BASE_REQUIRED_FILES;
}

async function writePinnedModel(path: string, kind: QwenRuntimeModelKind) {
  const pin = QWEN_RUNTIME_MANIFEST.models[kind];
  const files = [];
  for (const [index, name] of requiredFiles(kind).entries()) {
    const bytes = Buffer.from(`${kind}:${name}:${index}`, 'utf8');
    await writePath(join(deterministicQwenModelPath(path, kind), ...name.split('/')), bytes);
    files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
  }
  await writePath(
    join(deterministicQwenModelPath(path, kind), '.yaw-model.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      repository: pin.repository,
      revision: pin.revision,
      files,
    })}\n`,
  );
  return {
    repository: pin.repository,
    revision: pin.revision,
    path: deterministicQwenModelPath(path, kind),
    files,
  };
}

async function readyReceipt(
  path: string,
  options: { voiceDesign?: boolean; backend?: 'cpu' | 'cu128' } = {},
) {
  const backend = options.backend ?? 'cpu';
  const [base, asr, voiceDesign] = await Promise.all([
    writePinnedModel(path, 'base'),
    writePinnedModel(path, 'asr'),
    options.voiceDesign ? writePinnedModel(path, 'voiceDesign') : Promise.resolve(null),
  ]);
  return {
    schemaVersion: 2,
    state: 'ready',
    installerRevision: QWEN_RUNTIME_MANIFEST.installerRevision,
    installedAt: '2026-07-26T03:10:16.916Z',
    environmentPath: deterministicQwenEnvironmentPath(path),
    modelCachePath: deterministicQwenModelCachePath(path),
    torchBackend: backend,
    runtimeManifestSha256: QWEN_RUNTIME_MANIFEST_SHA256,
    runtime: {
      python: '3.12.10',
      qwenTts: QWEN_RUNTIME_MANIFEST.packages.qwenTts,
      transformers: QWEN_RUNTIME_MANIFEST.packages.transformers,
      accelerate: QWEN_RUNTIME_MANIFEST.packages.accelerate,
      torch: `${QWEN_RUNTIME_MANIFEST.packages.torch}+${backend}`,
      torchaudio: `${QWEN_RUNTIME_MANIFEST.packages.torchaudio}+${backend}`,
      cudaAvailable: backend === 'cu128',
      gpu: backend === 'cu128' ? 'Fixture GPU' : null,
    },
    models: {
      base,
      asr,
      ...(voiceDesign ? { voiceDesign } : {}),
    },
  };
}

async function writeReadyRuntime(
  path: string,
  options: { voiceDesign?: boolean; backend?: 'cpu' | 'cu128' } = {},
) {
  const receipt = await readyReceipt(path, options);
  await Promise.all([
    writePath(deterministicQwenPythonPath(path), 'fixture python'),
    writePath(deterministicQwenReceiptPath(path), `${JSON.stringify(receipt)}\n`),
  ]);
  return receipt;
}

describe('verified per-user Qwen3-TTS runtime', () => {
  it('pins the exact runtime contract bytes compiled into the desktop verifier', async () => {
    const bytes = await readFile(resolve('services/qwen-runtime-manifest.json'));
    expect(sha256(bytes)).toBe(QWEN_RUNTIME_MANIFEST_SHA256);
  });

  it('isolates probes from inherited voice, Python, package, cache, and token state', () => {
    const modelCachePath = 'C:\\verified Qwen cache';
    const environment = cleanQwenProbeEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        OTHER_SETTING: 'kept',
        YAW_QWEN_BASE_MODEL_PATH: 'C:\\wrong',
        PYTHONPATH: 'C:\\untrusted',
        PIP_INDEX_URL: 'https://untrusted.invalid',
        HF_TOKEN: 'secret',
        HUGGING_FACE_HUB_TOKEN: 'secret',
        CONDA_PREFIX: 'C:\\untrusted-conda',
        XDG_CACHE_HOME: 'C:\\untrusted-cache',
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
      CUBLAS_WORKSPACE_CONFIG: ':4096:8',
    });
    expect(environment.YAW_QWEN_BASE_MODEL_PATH).toBeUndefined();
    expect(environment.PYTHONPATH).toBeUndefined();
    expect(environment.PIP_INDEX_URL).toBeUndefined();
    expect(environment.HF_TOKEN).toBeUndefined();
    expect(environment.HUGGING_FACE_HUB_TOKEN).toBeUndefined();
    expect(environment.CONDA_PREFIX).toBeUndefined();
    expect(environment.XDG_CACHE_HOME).toBeUndefined();
  });

  it('accepts an exact production Base + ASR receipt at deterministic paths', async () => {
    const path = await userData();
    await writeReadyRuntime(path);

    await expect(
      inspectQwenRuntime(path, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'ready',
      environmentPath: deterministicQwenEnvironmentPath(path),
      pythonPath: deterministicQwenPythonPath(path),
      baseModelPath: deterministicQwenModelPath(path, 'base'),
      asrModelPath: deterministicQwenModelPath(path, 'asr'),
      receipt: {
        schemaVersion: 2,
        torchBackend: 'cpu',
        models: {
          base: { revision: QWEN_RUNTIME_MANIFEST.models.base.revision },
          asr: { revision: QWEN_RUNTIME_MANIFEST.models.asr.revision },
        },
      },
    });
  });

  it('also verifies an optional casting-only VoiceDesign snapshot when recorded', async () => {
    const path = await userData();
    await writeReadyRuntime(path, { voiceDesign: true, backend: 'cu128' });

    await expect(
      inspectQwenRuntime(path, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'ready',
      receipt: {
        torchBackend: 'cu128',
        models: {
          voiceDesign: {
            revision: QWEN_RUNTIME_MANIFEST.models.voiceDesign.revision,
          },
        },
      },
    });
  });

  it('distinguishes a missing install from an incomplete environment', async () => {
    const missing = await userData();
    const partial = await userData();
    await writePath(deterministicQwenPythonPath(partial), 'partial python');

    await expect(inspectQwenRuntime(missing)).resolves.toMatchObject({ state: 'missing' });
    await expect(inspectQwenRuntime(partial)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/receipt is missing/u),
    });
  });

  it.each([
    ['obsolete receipt schema', { schemaVersion: 1 }, /install receipt is invalid/u],
    [
      'wrong contract hash',
      { runtimeManifestSha256: '0'.repeat(64) },
      /install receipt is invalid/u,
    ],
    ['wrong environment', { environmentPath: 'C:\\Other\\qwen-venv' }, /different environment/u],
    ['wrong model cache', { modelCachePath: 'C:\\Other\\models' }, /different model-cache/u],
  ])('rejects %s', async (_description, patch, expected) => {
    const path = await userData();
    const receipt = await readyReceipt(path);
    await Promise.all([
      writePath(deterministicQwenPythonPath(path), 'fixture python'),
      writePath(deterministicQwenReceiptPath(path), JSON.stringify({ ...receipt, ...patch })),
    ]);

    await expect(
      inspectQwenRuntime(path, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(expected),
    });
  });

  it('rejects an altered, missing, or undeclared model file before probing Python', async () => {
    const alteredPath = await userData();
    const alteredReceipt = await writeReadyRuntime(alteredPath);
    const alteredFile = alteredReceipt.models.base.files[0];
    if (!alteredFile) throw new Error('Fixture has no Base file.');
    await writePath(
      join(deterministicQwenModelPath(alteredPath, 'base'), ...alteredFile.path.split('/')),
      Buffer.alloc(alteredFile.size, 0x7f),
    );

    await expect(
      inspectQwenRuntime(alteredPath, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/SHA-256 integrity check/u),
    });

    const missingPath = await userData();
    const missingReceipt = await writeReadyRuntime(missingPath);
    const missingFile = missingReceipt.models.asr.files[0];
    if (!missingFile) throw new Error('Fixture has no ASR file.');
    await rm(join(deterministicQwenModelPath(missingPath, 'asr'), ...missingFile.path.split('/')));
    await expect(
      inspectQwenRuntime(missingPath, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/could not be verified/u),
    });

    const undeclaredPath = await userData();
    const undeclaredReceipt = await readyReceipt(undeclaredPath);
    undeclaredReceipt.models.base.files.pop();
    await Promise.all([
      writePath(deterministicQwenPythonPath(undeclaredPath), 'fixture python'),
      writePath(deterministicQwenReceiptPath(undeclaredPath), JSON.stringify(undeclaredReceipt)),
    ]);
    await expect(
      inspectQwenRuntime(undeclaredPath, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/exact sorted pinned file inventory/u),
    });
  });

  it('rejects model paths and revision markers that do not match the pinned install', async () => {
    const wrongPath = await userData();
    const wrongPathReceipt = await readyReceipt(wrongPath);
    wrongPathReceipt.models.base.path = 'C:\\Elsewhere\\base';
    await Promise.all([
      writePath(deterministicQwenPythonPath(wrongPath), 'fixture python'),
      writePath(deterministicQwenReceiptPath(wrongPath), JSON.stringify(wrongPathReceipt)),
    ]);
    await expect(
      inspectQwenRuntime(wrongPath, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/outside its deterministic model path/u),
    });

    const wrongMarker = await userData();
    await writeReadyRuntime(wrongMarker);
    await writePath(
      join(deterministicQwenModelPath(wrongMarker, 'asr'), '.yaw-model.json'),
      JSON.stringify({
        schemaVersion: 2,
        repository: QWEN_RUNTIME_MANIFEST.models.asr.repository,
        revision: '0'.repeat(40),
        files: [],
      }),
    );
    await expect(
      inspectQwenRuntime(wrongMarker, { probe: successfulRuntimeProbe }),
    ).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/does not match the trusted repository and revision/u),
    });
  });

  it('fails closed when the isolated package and model probe fails', async () => {
    const path = await userData();
    await writeReadyRuntime(path);
    const probe = async () => {
      throw new Error('Base model load failed');
    };

    await expect(inspectQwenRuntime(path, { probe })).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/package probe failed: Base model load failed/u),
    });
  });
});
