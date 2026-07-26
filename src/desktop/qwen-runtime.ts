import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import runtimeManifestInput from '../../services/qwen-runtime-manifest.json';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;

const RuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    installerRevision: z.string().trim().min(1),
    python: z
      .object({
        major: z.literal(3),
        minor: z.literal(12),
        architecture: z.literal('64bit'),
      })
      .strict(),
    packages: z
      .object({
        qwenTts: z.string().trim().min(1),
        qwenTtsWheelSha256: z.string().regex(SHA256_PATTERN),
        transformers: z.string().trim().min(1),
        accelerate: z.string().trim().min(1),
        torch: z.string().trim().min(1),
        torchaudio: z.string().trim().min(1),
      })
      .strict(),
    torchIndexes: z
      .object({
        cpu: z.string().url(),
        cu128: z.string().url(),
      })
      .strict(),
    attentionImplementation: z.literal('sdpa'),
    models: z
      .object({
        voiceDesign: z
          .object({
            repository: z.literal('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'),
            revision: z.string().regex(REVISION_PATTERN),
            license: z.literal('Apache-2.0'),
          })
          .strict(),
        base: z
          .object({
            repository: z.literal('Qwen/Qwen3-TTS-12Hz-0.6B-Base'),
            revision: z.string().regex(REVISION_PATTERN),
            license: z.literal('Apache-2.0'),
          })
          .strict(),
        asr: z
          .object({
            repository: z.literal('openai/whisper-small.en'),
            revision: z.string().regex(REVISION_PATTERN),
            license: z.literal('Apache-2.0'),
          })
          .strict(),
      })
      .strict(),
    qa: z
      .object({
        policyRevision: z.string().trim().min(1),
        silentGuardMs: z.number().int().min(200),
        maximumWordErrorRate: z.number().min(0).max(0.5),
        maximumEdgeSilenceMs: z.number().int().min(200),
        maximumFullScaleRatio: z.number().min(0).max(0.05),
      })
      .strict(),
  })
  .strict();

export const QWEN_RUNTIME_MANIFEST = RuntimeManifestSchema.parse(runtimeManifestInput);

// This digest covers the exact UTF-8 bytes of services/qwen-runtime-manifest.json.
// The installer writes it into the receipt, so a receipt from a different runtime
// contract cannot be accepted even when its field names happen to remain compatible.
export const QWEN_RUNTIME_MANIFEST_SHA256 =
  '779aef0482c500bd8e178e35b1be5a01d8ec710eb22c841daa0cd78a9456e60f';

export const QWEN_BASE_REQUIRED_FILES = [
  'config.json',
  'generation_config.json',
  'merges.txt',
  'model.safetensors',
  'preprocessor_config.json',
  'speech_tokenizer/config.json',
  'speech_tokenizer/configuration.json',
  'speech_tokenizer/model.safetensors',
  'speech_tokenizer/preprocessor_config.json',
  'tokenizer_config.json',
  'vocab.json',
] as const;

export const QWEN_ASR_REQUIRED_FILES = [
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'merges.txt',
  'model.safetensors',
  'normalizer.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
] as const;

export const QWEN_VOICE_DESIGN_REQUIRED_FILES = QWEN_BASE_REQUIRED_FILES;

export type QwenRuntimeModelKind = 'voiceDesign' | 'base' | 'asr';

const RuntimeFileReceiptSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          !value.includes('\\') &&
          !value.startsWith('/') &&
          !value.includes('\0') &&
          value
            .split('/')
            .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
        'Model file paths must be safe relative POSIX paths.',
      ),
    size: z.number().int().positive(),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const runtimeModelReceiptSchema = (kind: QwenRuntimeModelKind) => {
  const pin = QWEN_RUNTIME_MANIFEST.models[kind];
  return z
    .object({
      repository: z.literal(pin.repository),
      revision: z.literal(pin.revision),
      path: z.string().trim().min(1),
      files: z.array(RuntimeFileReceiptSchema).min(1),
    })
    .strict()
    .superRefine((model, context) => {
      const expected =
        kind === 'asr'
          ? QWEN_ASR_REQUIRED_FILES
          : kind === 'base'
            ? QWEN_BASE_REQUIRED_FILES
            : QWEN_VOICE_DESIGN_REQUIRED_FILES;
      const actual = model.files.map((file) => file.path);
      if (
        actual.length !== expected.length ||
        actual.some((path, index) => path !== expected[index])
      ) {
        context.addIssue({
          code: 'custom',
          path: ['files'],
          message: `${kind} must contain the exact sorted pinned file inventory.`,
        });
      }
    });
};

function versionWithOptionalBuild(version: string): RegExp {
  return new RegExp(`^${version.replaceAll('.', '\\.')}(?:\\+[a-z0-9._-]+)?$`, 'iu');
}

const RuntimeReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    state: z.literal('ready'),
    installerRevision: z.literal(QWEN_RUNTIME_MANIFEST.installerRevision),
    installedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
      message: 'installedAt must be an ISO timestamp.',
    }),
    environmentPath: z.string().trim().min(1),
    modelCachePath: z.string().trim().min(1),
    torchBackend: z.enum(['cpu', 'cu128']),
    runtimeManifestSha256: z.literal(QWEN_RUNTIME_MANIFEST_SHA256),
    runtime: z
      .object({
        python: z.string().regex(/^3\.12\.\d+(?:[a-z0-9.+-]*)?$/iu),
        qwenTts: z.literal(QWEN_RUNTIME_MANIFEST.packages.qwenTts),
        transformers: z.literal(QWEN_RUNTIME_MANIFEST.packages.transformers),
        accelerate: z.literal(QWEN_RUNTIME_MANIFEST.packages.accelerate),
        torch: z.string().regex(versionWithOptionalBuild(QWEN_RUNTIME_MANIFEST.packages.torch)),
        torchaudio: z
          .string()
          .regex(versionWithOptionalBuild(QWEN_RUNTIME_MANIFEST.packages.torchaudio)),
        cudaAvailable: z.boolean(),
        gpu: z.string().trim().min(1).nullable(),
      })
      .strict(),
    models: z
      .object({
        base: runtimeModelReceiptSchema('base'),
        asr: runtimeModelReceiptSchema('asr'),
        voiceDesign: runtimeModelReceiptSchema('voiceDesign').nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const torchBuild = receipt.runtime.torch.split('+')[1]?.toLowerCase();
    const torchaudioBuild = receipt.runtime.torchaudio.split('+')[1]?.toLowerCase();
    if (receipt.torchBackend === 'cu128') {
      if (
        receipt.runtime.cudaAvailable !== true ||
        !receipt.runtime.gpu ||
        torchBuild !== 'cu128' ||
        torchaudioBuild !== 'cu128'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['runtime'],
          message: 'The cu128 receipt must report matched CUDA builds and an available GPU.',
        });
      }
    } else if (
      receipt.runtime.cudaAvailable !== false ||
      receipt.runtime.gpu !== null ||
      (torchBuild !== undefined && torchBuild !== 'cpu') ||
      (torchaudioBuild !== undefined && torchaudioBuild !== 'cpu')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'The CPU receipt must report CPU packages and no CUDA device.',
      });
    }
  });

export type QwenRuntimeReceipt = z.infer<typeof RuntimeReceiptSchema>;

export interface QwenRuntimeProbeInput {
  environmentPath: string;
  pythonPath: string;
  modelCachePath: string;
  baseModelPath: string;
  asrModelPath: string;
  receipt: QwenRuntimeReceipt;
  inheritedEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type QwenRuntimeProbe = (input: QwenRuntimeProbeInput) => Promise<void>;

export interface InspectQwenRuntimeOptions {
  probe?: QwenRuntimeProbe;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type QwenRuntimeInspection =
  | {
      state: 'ready';
      environmentPath: string;
      pythonPath: string;
      receiptPath: string;
      baseModelPath: string;
      asrModelPath: string;
      receipt: QwenRuntimeReceipt;
    }
  | {
      state: 'missing' | 'invalid';
      environmentPath: string;
      pythonPath: string;
      receiptPath: string;
      message: string;
    };

function normalizedPath(path: string): string {
  return resolve(path).toLocaleLowerCase('en-US');
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const digest = createHash('sha256');
    const source = createReadStream(path);
    source.on('data', (chunk: Buffer | string) => {
      digest.update(chunk);
    });
    source.once('error', rejectPromise);
    source.once('end', () => resolvePromise(digest.digest('hex')));
  });
}

export function deterministicQwenEnvironmentPath(userDataDirectory: string): string {
  return join(resolve(userDataDirectory), 'voice-runtime', 'qwen3-tts-venv');
}

export function deterministicQwenPythonPath(userDataDirectory: string): string {
  return join(deterministicQwenEnvironmentPath(userDataDirectory), 'Scripts', 'python.exe');
}

export function deterministicQwenModelCachePath(userDataDirectory: string): string {
  return join(resolve(userDataDirectory), 'voice-runtime', 'qwen-model-cache');
}

export function deterministicQwenModelPath(
  userDataDirectory: string,
  kind: QwenRuntimeModelKind,
): string {
  const revision = QWEN_RUNTIME_MANIFEST.models[kind].revision;
  const prefix = kind === 'voiceDesign' ? 'voice-design' : kind;
  return join(deterministicQwenModelCachePath(userDataDirectory), `${prefix}-${revision}`);
}

export function deterministicQwenReceiptPath(userDataDirectory: string): string {
  return join(deterministicQwenEnvironmentPath(userDataDirectory), 'yaw-qwen-runtime.json');
}

export function cleanQwenProbeEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  modelCachePath: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inheritedEnvironment };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith('YAW_') ||
      normalized.startsWith('PIP_') ||
      normalized.startsWith('HF_') ||
      normalized.startsWith('HUGGING_FACE_') ||
      normalized.startsWith('HUGGINGFACE_') ||
      normalized.startsWith('TRANSFORMERS_') ||
      normalized.startsWith('PYTHON') ||
      normalized === 'TORCH_HOME' ||
      normalized === 'VIRTUAL_ENV' ||
      normalized.startsWith('CONDA_') ||
      normalized === 'XDG_CACHE_HOME'
    ) {
      delete environment[key];
    }
  }
  environment.HF_HOME = join(modelCachePath, 'huggingface');
  environment.HUGGINGFACE_HUB_CACHE = join(environment.HF_HOME, 'hub');
  environment.TORCH_HOME = join(modelCachePath, 'torch');
  environment.HF_HUB_OFFLINE = '1';
  environment.HF_HUB_DISABLE_TELEMETRY = '1';
  environment.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
  environment.TRANSFORMERS_OFFLINE = '1';
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONUTF8 = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.CUBLAS_WORKSPACE_CONFIG = ':4096:8';
  return environment;
}

const successfulRuntimeProbes = new Map<string, Promise<void>>();

async function runQwenRuntimeProbeOnce(input: QwenRuntimeProbeInput): Promise<void> {
  const script = [
    'import gc',
    'import importlib.metadata as metadata',
    'import json',
    'import os',
    'import platform',
    'import sys',
    'import torch',
    'import torchaudio',
    'import transformers',
    'from pathlib import Path',
    'from qwen_tts import Qwen3TTSModel',
    'from transformers import AutoConfig',
    'base_path, asr_path, environment_path, torch_backend = sys.argv[1:5]',
    "assert sys.version_info[:2] == (3, 12), 'Python 3.12 is required'",
    "assert platform.architecture()[0] == '64bit', '64-bit Python is required'",
    "assert os.path.normcase(str(Path(sys.prefix).resolve())) == os.path.normcase(str(Path(environment_path).resolve())), 'Python prefix mismatch'",
    "device = 'cpu' if torch_backend == 'cpu' else 'cuda:0'",
    "if torch_backend != 'cpu' and not torch.cuda.is_available(): raise RuntimeError('The verified CUDA backend is unavailable')",
    "dtype = torch.float32 if device == 'cpu' else torch.bfloat16",
    "model = Qwen3TTSModel.from_pretrained(base_path, device_map=device, dtype=dtype, attn_implementation='sdpa', local_files_only=True)",
    'asr_config = AutoConfig.from_pretrained(asr_path, local_files_only=True)',
    "assert getattr(asr_config, 'model_type', None) == 'whisper', 'The offline QA model is not Whisper'",
    'del model',
    'gc.collect()',
    'if torch.cuda.is_available(): torch.cuda.empty_cache()',
    'payload = {',
    "  'python': platform.python_version(),",
    "  'qwenTts': metadata.version('qwen-tts'),",
    "  'transformers': metadata.version('transformers'),",
    "  'accelerate': metadata.version('accelerate'),",
    "  'torch': torch.__version__,",
    "  'torchaudio': torchaudio.__version__,",
    "  'cudaAvailable': torch.cuda.is_available(),",
    "  'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,",
    '}',
    "print('YAW_QWEN_RUNTIME_PROBE:' + json.dumps(payload, sort_keys=True))",
  ].join('\n');

  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      input.pythonPath,
      [
        '-I',
        '-c',
        script,
        input.baseModelPath,
        input.asrModelPath,
        input.environmentPath,
        input.receipt.torchBackend,
      ],
      {
        cwd: input.environmentPath,
        env: cleanQwenProbeEnvironment(input.inheritedEnvironment, input.modelCachePath),
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 512 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          const sentinel = stdout
            .split(/\r?\n/u)
            .findLast((line) => line.startsWith('YAW_QWEN_RUNTIME_PROBE:'));
          if (sentinel) {
            try {
              const payload = JSON.parse(
                sentinel.slice('YAW_QWEN_RUNTIME_PROBE:'.length),
              ) as Record<string, unknown>;
              const expected = input.receipt.runtime;
              if (
                payload.python === expected.python &&
                payload.qwenTts === expected.qwenTts &&
                payload.transformers === expected.transformers &&
                payload.accelerate === expected.accelerate &&
                payload.torch === expected.torch &&
                payload.torchaudio === expected.torchaudio &&
                payload.cudaAvailable === expected.cudaAvailable &&
                payload.gpu === expected.gpu
              ) {
                resolvePromise();
                return;
              }
              rejectPromise(new Error('The runtime probe metadata did not match its receipt.'));
              return;
            } catch {
              rejectPromise(new Error('The runtime probe returned malformed metadata.'));
              return;
            }
          }
        }
        const detail = stderr.trim() || stdout.trim() || error?.message || 'unknown probe failure';
        rejectPromise(new Error(detail.slice(-4_000)));
      },
    );
  });
}

export const runQwenRuntimeProbe: QwenRuntimeProbe = (input) => {
  const key = JSON.stringify([
    normalizedPath(input.pythonPath),
    normalizedPath(input.baseModelPath),
    normalizedPath(input.asrModelPath),
    input.receipt.installerRevision,
    input.receipt.installedAt,
    input.receipt.runtimeManifestSha256,
    input.receipt.runtime,
    input.receipt.models.base.files,
    input.receipt.models.asr.files,
  ]);
  const existing = successfulRuntimeProbes.get(key);
  if (existing) return existing;
  let probe: Promise<void>;
  probe = runQwenRuntimeProbeOnce(input).catch((error: unknown) => {
    if (successfulRuntimeProbes.get(key) === probe) successfulRuntimeProbes.delete(key);
    throw error;
  });
  successfulRuntimeProbes.set(key, probe);
  return probe;
};

async function inspectModelFiles(
  modelPath: string,
  kind: 'base' | 'asr' | 'voiceDesign',
  receipt: {
    files: Array<{ path: string; size: number; sha256: string }>;
  },
): Promise<string | null> {
  const markerPath = join(modelPath, '.yaw-model.json');
  let markerInput: unknown;
  try {
    markerInput = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch {
    return `The pinned ${kind} model revision marker is missing or invalid.`;
  }
  const expectedPin = QWEN_RUNTIME_MANIFEST.models[kind];
  const marker = z
    .object({
      schemaVersion: z.literal(2),
      repository: z.literal(expectedPin.repository),
      revision: z.literal(expectedPin.revision),
      files: z.array(RuntimeFileReceiptSchema),
    })
    .strict()
    .safeParse(markerInput);
  if (!marker.success) {
    return `The pinned ${kind} model marker does not match the trusted repository and revision.`;
  }
  if (JSON.stringify(marker.data.files) !== JSON.stringify(receipt.files)) {
    return `The pinned ${kind} model marker does not match its verified file inventory.`;
  }

  for (const file of receipt.files) {
    const path = join(modelPath, ...file.path.split('/'));
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size !== file.size || details.size <= 0) {
        return `The pinned ${kind} model file "${file.path}" has the wrong type or size.`;
      }
      const actualSha256 = await sha256File(path);
      if (actualSha256 !== file.sha256) {
        return `The pinned ${kind} model file "${file.path}" failed its SHA-256 integrity check.`;
      }
    } catch (error) {
      return `The pinned ${kind} model file "${file.path}" could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return null;
}

export async function inspectQwenRuntime(
  userDataDirectory: string,
  options: InspectQwenRuntimeOptions = {},
): Promise<QwenRuntimeInspection> {
  const environmentPath = deterministicQwenEnvironmentPath(userDataDirectory);
  const pythonPath = deterministicQwenPythonPath(userDataDirectory);
  const receiptPath = deterministicQwenReceiptPath(userDataDirectory);
  const pythonExists = await regularFile(pythonPath);

  let receiptText: string;
  try {
    receiptText = await readFile(receiptPath, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      state: pythonExists ? 'invalid' : 'missing',
      environmentPath,
      pythonPath,
      receiptPath,
      message: missing
        ? pythonExists
          ? 'The Qwen3-TTS environment is incomplete because its verified install receipt is missing.'
          : `Qwen3-TTS is not installed at "${environmentPath}".`
        : `The Qwen3-TTS install receipt could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
    };
  }

  let receiptInput: unknown;
  try {
    receiptInput = JSON.parse(receiptText) as unknown;
  } catch {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Qwen3-TTS install receipt is not valid JSON.',
    };
  }

  const parsed = RuntimeReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The Qwen3-TTS install receipt is invalid: ${
        parsed.error.issues[0]?.message ?? 'schema validation failed'
      }`,
    };
  }
  const receipt = parsed.data;
  const modelCachePath = deterministicQwenModelCachePath(userDataDirectory);
  if (normalizedPath(receipt.environmentPath) !== normalizedPath(environmentPath)) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Qwen3-TTS install receipt belongs to a different environment path.',
    };
  }
  if (normalizedPath(receipt.modelCachePath) !== normalizedPath(modelCachePath)) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Qwen3-TTS install receipt belongs to a different model-cache path.',
    };
  }
  if (!pythonExists) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The verified Qwen3-TTS Python executable is missing: "${pythonPath}".`,
    };
  }

  const baseModelPath = deterministicQwenModelPath(userDataDirectory, 'base');
  const asrModelPath = deterministicQwenModelPath(userDataDirectory, 'asr');
  for (const [kind, model, expectedPath] of [
    ['base', receipt.models.base, baseModelPath],
    ['asr', receipt.models.asr, asrModelPath],
  ] as const) {
    if (normalizedPath(model.path) !== normalizedPath(expectedPath)) {
      return {
        state: 'invalid',
        environmentPath,
        pythonPath,
        receiptPath,
        message: `The Qwen3-TTS ${kind} receipt points outside its deterministic model path.`,
      };
    }
    const fileError = await inspectModelFiles(expectedPath, kind, model);
    if (fileError) {
      return {
        state: 'invalid',
        environmentPath,
        pythonPath,
        receiptPath,
        message: fileError,
      };
    }
  }

  if (receipt.models.voiceDesign) {
    const voiceDesignPath = deterministicQwenModelPath(userDataDirectory, 'voiceDesign');
    if (normalizedPath(receipt.models.voiceDesign.path) !== normalizedPath(voiceDesignPath)) {
      return {
        state: 'invalid',
        environmentPath,
        pythonPath,
        receiptPath,
        message: 'The Qwen3-TTS VoiceDesign receipt points outside its deterministic model path.',
      };
    }
    const fileError = await inspectModelFiles(
      voiceDesignPath,
      'voiceDesign',
      receipt.models.voiceDesign,
    );
    if (fileError) {
      return {
        state: 'invalid',
        environmentPath,
        pythonPath,
        receiptPath,
        message: fileError,
      };
    }
  }

  const probe = options.probe ?? runQwenRuntimeProbe;
  try {
    await probe({
      environmentPath,
      pythonPath,
      modelCachePath,
      baseModelPath,
      asrModelPath,
      receipt,
      inheritedEnvironment: options.inheritedEnvironment ?? process.env,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message:
        'The Qwen3-TTS runtime package probe failed: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  return {
    state: 'ready',
    environmentPath,
    pythonPath,
    receiptPath,
    baseModelPath,
    asrModelPath,
    receipt,
  };
}
