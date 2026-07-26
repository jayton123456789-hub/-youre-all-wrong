import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import runtimeManifestInput from '../../services/chatterbox-runtime-manifest.json';

const RuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    installerRevision: z.string().trim().min(1),
    python: z
      .object({
        major: z.literal(3),
        minor: z.literal(11),
      })
      .strict(),
    packages: z
      .object({
        chatterboxTts: z.string().trim().min(1),
        torch: z.string().trim().min(1),
        torchaudio: z.string().trim().min(1),
      })
      .strict(),
    models: z
      .object({
        turbo: z
          .object({
            repository: z.literal('ResembleAI/chatterbox-turbo'),
            revision: z.string().regex(/^[a-f0-9]{40}$/u),
            requiredFiles: z.array(z.string().regex(/^[a-z0-9_.-]+$/u)).min(1),
          })
          .strict(),
        original: z
          .object({
            repository: z.literal('ResembleAI/chatterbox'),
            revision: z.string().regex(/^[a-f0-9]{40}$/u),
            requiredFiles: z.array(z.string().regex(/^[a-z0-9_.-]+$/u)).min(1),
          })
          .strict(),
      })
      .strict(),
    perthRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .strict();

export const CHATTERBOX_RUNTIME_MANIFEST = RuntimeManifestSchema.parse(runtimeManifestInput);

const RuntimeReceiptSchemaBase = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal('chatterbox'),
    installerRevision: z.literal(CHATTERBOX_RUNTIME_MANIFEST.installerRevision),
    environmentPath: z.string().trim().min(1),
    modelCachePath: z.string().trim().min(1),
    model: z.enum(['turbo', 'original']),
    modelRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    pythonVersion: z.string().regex(/^3\.11\.\d+(?:[a-z0-9.+-]*)?$/iu),
    pythonArchitecture: z.literal('64bit'),
    chatterboxTtsVersion: z.literal(CHATTERBOX_RUNTIME_MANIFEST.packages.chatterboxTts),
    torchVersion: z
      .string()
      .regex(
        new RegExp(
          `^${CHATTERBOX_RUNTIME_MANIFEST.packages.torch.replaceAll('.', '\\.')}(?:\\+[a-z0-9._-]+)?$`,
          'iu',
        ),
      ),
    torchaudioVersion: z
      .string()
      .regex(
        new RegExp(
          `^${CHATTERBOX_RUNTIME_MANIFEST.packages.torchaudio.replaceAll('.', '\\.')}(?:\\+[a-z0-9._-]+)?$`,
          'iu',
        ),
      ),
    torchBackend: z.enum(['cpu', 'cu124', 'cu126']),
    perthRevision: z.literal(CHATTERBOX_RUNTIME_MANIFEST.perthRevision),
    healthCheck: z.literal('model-loaded-no-audio'),
    installedAtUtc: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
      message: 'installedAtUtc must be an ISO timestamp.',
    }),
  })
  .strict();

const RuntimeReceiptSchema = RuntimeReceiptSchemaBase.superRefine((receipt, context) => {
  if (receipt.modelRevision !== CHATTERBOX_RUNTIME_MANIFEST.models[receipt.model].revision) {
    context.addIssue({
      code: 'custom',
      path: ['modelRevision'],
      message: `modelRevision does not match the pinned ${receipt.model} model.`,
    });
  }
});

export type ChatterboxRuntimeReceipt = z.infer<typeof RuntimeReceiptSchema>;

export interface ChatterboxRuntimeProbeInput {
  environmentPath: string;
  pythonPath: string;
  modelCachePath: string;
  modelSnapshotPath: string;
  receipt: ChatterboxRuntimeReceipt;
  inheritedEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ChatterboxRuntimeProbe = (input: ChatterboxRuntimeProbeInput) => Promise<void>;

export interface InspectChatterboxRuntimeOptions {
  probe?: ChatterboxRuntimeProbe;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ChatterboxRuntimeInspection =
  | {
      state: 'ready';
      environmentPath: string;
      pythonPath: string;
      receiptPath: string;
      receipt: ChatterboxRuntimeReceipt;
    }
  | {
      state: 'missing' | 'invalid';
      environmentPath: string;
      pythonPath: string;
      receiptPath: string;
      message: string;
    };

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function deterministicChatterboxEnvironmentPath(userDataDirectory: string): string {
  return join(resolve(userDataDirectory), 'voice-runtime', 'chatterbox-venv');
}

export function deterministicChatterboxPythonPath(userDataDirectory: string): string {
  return join(deterministicChatterboxEnvironmentPath(userDataDirectory), 'Scripts', 'python.exe');
}

export function deterministicChatterboxModelCachePath(userDataDirectory: string): string {
  return join(resolve(userDataDirectory), 'voice-runtime', 'model-cache');
}

export function deterministicChatterboxModelRepositoryPath(
  userDataDirectory: string,
  model: ChatterboxRuntimeReceipt['model'],
): string {
  const repository = CHATTERBOX_RUNTIME_MANIFEST.models[model].repository.replaceAll('/', '--');
  return join(
    deterministicChatterboxModelCachePath(userDataDirectory),
    'huggingface',
    'hub',
    `models--${repository}`,
  );
}

export function deterministicChatterboxModelSnapshotPath(
  userDataDirectory: string,
  model: ChatterboxRuntimeReceipt['model'],
): string {
  return join(
    deterministicChatterboxModelRepositoryPath(userDataDirectory, model),
    'snapshots',
    CHATTERBOX_RUNTIME_MANIFEST.models[model].revision,
  );
}

export function deterministicChatterboxReceiptPath(userDataDirectory: string): string {
  return join(deterministicChatterboxEnvironmentPath(userDataDirectory), 'yaw-runtime.json');
}

export function cleanChatterboxProbeEnvironment(
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
  return environment;
}

const successfulRuntimeProbes = new Map<string, Promise<void>>();

async function runChatterboxRuntimeProbeOnce(input: ChatterboxRuntimeProbeInput): Promise<void> {
  const script = [
    'import importlib.metadata as metadata',
    'import json',
    'import os',
    'import platform',
    'import sys',
    'from pathlib import Path',
    'import chatterbox',
    'import perth',
    'import torch',
    'import torchaudio',
    'from chatterbox.tts import ChatterboxTTS',
    'from chatterbox.tts_turbo import ChatterboxTurboTTS',
    'snapshot_path, environment_path, model_kind, torch_backend = sys.argv[1:5]',
    "assert sys.version_info[:2] == (3, 11), 'Python 3.11 is required'",
    "assert platform.architecture()[0] == '64bit', '64-bit Python is required'",
    "assert os.path.normcase(str(Path(sys.prefix).resolve())) == os.path.normcase(str(Path(environment_path).resolve())), 'Python prefix mismatch'",
    "device = 'cpu' if torch_backend == 'cpu' else 'cuda'",
    "if device == 'cuda' and not torch.cuda.is_available(): raise RuntimeError('The verified CUDA backend is unavailable')",
    'model_class = ChatterboxTurboTTS if model_kind == "turbo" else ChatterboxTTS',
    'model = model_class.from_local(snapshot_path, device=device)',
    'payload = {',
    "  'pythonVersion': platform.python_version(),",
    "  'pythonArchitecture': platform.architecture()[0],",
    "  'chatterboxTtsVersion': metadata.version('chatterbox-tts'),",
    "  'torchVersion': torch.__version__,",
    "  'torchaudioVersion': torchaudio.__version__,",
    "  'model': model_kind,",
    "  'sampleRate': int(model.sr),",
    '}',
    "print('YAW_RUNTIME_PROBE:' + json.dumps(payload, sort_keys=True))",
  ].join('\n');

  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      input.pythonPath,
      [
        '-I',
        '-c',
        script,
        input.modelSnapshotPath,
        input.environmentPath,
        input.receipt.model,
        input.receipt.torchBackend,
      ],
      {
        cwd: input.environmentPath,
        env: cleanChatterboxProbeEnvironment(input.inheritedEnvironment, input.modelCachePath),
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 256 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          const sentinel = stdout
            .split(/\r?\n/u)
            .findLast((line) => line.startsWith('YAW_RUNTIME_PROBE:'));
          if (sentinel) {
            try {
              const payload = JSON.parse(sentinel.slice('YAW_RUNTIME_PROBE:'.length)) as Record<
                string,
                unknown
              >;
              if (
                payload.pythonVersion === input.receipt.pythonVersion &&
                payload.pythonArchitecture === input.receipt.pythonArchitecture &&
                payload.chatterboxTtsVersion === input.receipt.chatterboxTtsVersion &&
                payload.torchVersion === input.receipt.torchVersion &&
                payload.torchaudioVersion === input.receipt.torchaudioVersion &&
                payload.model === input.receipt.model &&
                typeof payload.sampleRate === 'number' &&
                payload.sampleRate > 0
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

export const runChatterboxRuntimeProbe: ChatterboxRuntimeProbe = (input) => {
  const key = JSON.stringify([
    resolve(input.pythonPath),
    resolve(input.modelSnapshotPath),
    input.receipt.installerRevision,
    input.receipt.installedAtUtc,
    input.receipt.model,
    input.receipt.modelRevision,
    input.receipt.pythonVersion,
    input.receipt.chatterboxTtsVersion,
    input.receipt.torchVersion,
    input.receipt.torchaudioVersion,
    input.receipt.torchBackend,
  ]);
  const existing = successfulRuntimeProbes.get(key);
  if (existing) return existing;
  let probe: Promise<void>;
  probe = runChatterboxRuntimeProbeOnce(input).catch((error: unknown) => {
    if (successfulRuntimeProbes.get(key) === probe) successfulRuntimeProbes.delete(key);
    throw error;
  });
  successfulRuntimeProbes.set(key, probe);
  return probe;
};

export async function inspectChatterboxRuntime(
  userDataDirectory: string,
  options: InspectChatterboxRuntimeOptions = {},
): Promise<ChatterboxRuntimeInspection> {
  const environmentPath = deterministicChatterboxEnvironmentPath(userDataDirectory);
  const pythonPath = deterministicChatterboxPythonPath(userDataDirectory);
  const receiptPath = deterministicChatterboxReceiptPath(userDataDirectory);
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
          ? 'The Chatterbox environment is incomplete because its verified install receipt is missing.'
          : `Chatterbox is not installed at "${environmentPath}".`
        : `The Chatterbox install receipt could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(receiptText) as unknown;
  } catch {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Chatterbox install receipt is not valid JSON.',
    };
  }

  const parsed = RuntimeReceiptSchema.safeParse(input);
  if (!parsed.success) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The Chatterbox install receipt is invalid: ${
        parsed.error.issues[0]?.message ?? 'schema validation failed'
      }`,
    };
  }
  if (resolve(parsed.data.environmentPath) !== resolve(environmentPath)) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Chatterbox install receipt belongs to a different environment path.',
    };
  }
  if (
    resolve(parsed.data.modelCachePath) !==
    resolve(deterministicChatterboxModelCachePath(userDataDirectory))
  ) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: 'The Chatterbox install receipt belongs to a different model-cache path.',
    };
  }
  if (!pythonExists) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The verified Chatterbox Python executable is missing: "${pythonPath}".`,
    };
  }

  const modelSnapshotPath = deterministicChatterboxModelSnapshotPath(
    userDataDirectory,
    parsed.data.model,
  );
  const missingModelFiles: string[] = [];
  for (const name of CHATTERBOX_RUNTIME_MANIFEST.models[parsed.data.model].requiredFiles) {
    const path = join(modelSnapshotPath, name);
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size <= 0) missingModelFiles.push(name);
    } catch {
      missingModelFiles.push(name);
    }
  }
  if (missingModelFiles.length > 0) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message:
        `The pinned ${parsed.data.model} model snapshot is incomplete at "${modelSnapshotPath}". ` +
        `Missing or empty: ${missingModelFiles.join(', ')}. Repair the neural host runtime.`,
    };
  }

  const mainReferencePath = join(
    deterministicChatterboxModelRepositoryPath(userDataDirectory, parsed.data.model),
    'refs',
    'main',
  );
  let mainReference: string;
  try {
    mainReference = (await readFile(mainReferencePath, 'utf8')).trim();
  } catch {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The pinned ${parsed.data.model} model reference is missing. Repair the neural host runtime.`,
    };
  }
  if (mainReference !== parsed.data.modelRevision) {
    return {
      state: 'invalid',
      environmentPath,
      pythonPath,
      receiptPath,
      message: `The cached ${parsed.data.model} model reference does not match its verified revision.`,
    };
  }

  const probe = options.probe ?? runChatterboxRuntimeProbe;
  try {
    await probe({
      environmentPath,
      pythonPath,
      modelCachePath: parsed.data.modelCachePath,
      modelSnapshotPath,
      receipt: parsed.data,
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
        'The Chatterbox runtime package probe failed: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  return {
    state: 'ready',
    environmentPath,
    pythonPath,
    receiptPath,
    receipt: parsed.data,
  };
}
