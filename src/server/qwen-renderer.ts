import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import { canonicalJson } from '../domain/canonical.js';
import { DeliveryStyleSchema } from '../domain/showpack/schema.js';
import type {
  VoiceRendererConfig,
  VoiceWorkerManifest,
  VoiceWorkerRunner,
  WorkerProgress,
} from './voice-preflight.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_CUE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/iu;
const MODEL_MARKER_NAME = '.yaw-model.json';
const MAXIMUM_RENDER_JOBS = 4_000;
const QWEN_RENDER_BASE_SEED = 1_730_324_455;
const QWEN_RENDER_POLICY_REVISION = 'yaw-qwen-incremental-batch2-v1';

export const QWEN_ENVIRONMENT_PATHS = {
  python: 'YAW_QWEN_PYTHON_PATH',
  baseModel: 'YAW_QWEN_BASE_MODEL_PATH',
  asrModel: 'YAW_QWEN_ASR_MODEL_PATH',
  approval: 'YAW_QWEN_APPROVAL_PATH',
  runtimeManifest: 'YAW_QWEN_RUNTIME_MANIFEST_PATH',
  worker: 'YAW_VOICE_WORKER_PATH',
} as const;

const QWEN_GENERATION = {
  doSample: true,
  topK: 50,
  topP: 1,
  temperature: 0.9,
  repetitionPenalty: 1.05,
  subtalkerDoSample: true,
  subtalkerTopK: 50,
  subtalkerTopP: 1,
  subtalkerTemperature: 0.9,
  maxNewTokens: 2_048,
} as const;

const ModelPinSchema = z
  .object({
    repository: z.string().trim().min(1),
    revision: z.string().regex(MODEL_REVISION_PATTERN),
    license: z.string().trim().min(1),
  })
  .passthrough();

const QwenRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    installerRevision: z.string().trim().min(1),
    packages: z
      .object({
        qwenTts: z.string().trim().min(1),
        transformers: z.string().trim().min(1),
      })
      .passthrough(),
    models: z
      .object({
        base: ModelPinSchema,
        asr: ModelPinSchema,
      })
      .passthrough(),
    qa: z
      .object({
        policyRevision: z.string().trim().min(1),
        silentGuardMs: z.number().int().min(200),
      })
      .passthrough(),
  })
  .passthrough();

const VoiceApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('approved'),
    engine: z.literal('qwen3-tts'),
    syntheticOriginal: z.literal(true),
    voiceId: z.string().trim().min(1),
    voiceName: z.string().trim().min(1),
    approvedAsRendered: z.literal(true),
    reference: z
      .object({
        file: z.string().trim().min(1),
        sha256: z.string().regex(SHA256_PATTERN),
        transcript: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  })
  .passthrough();

const ModelMarkerSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    repository: z.string().trim().min(1),
    revision: z.string().regex(MODEL_REVISION_PATTERN),
  })
  .passthrough();

const GenericWorkerManifestSchema = z
  .object({
    protocolVersion: z.literal(1),
    voiceName: z.string().trim().min(1),
    jobs: z
      .array(
        z
          .object({
            cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
            cacheKey: z.string().regex(SHA256_PATTERN),
            outputPath: z.string().trim().min(1),
            text: z.string().trim().min(1).max(4_000),
            delivery: DeliveryStyleSchema,
            pacePermille: z.number().int().min(650).max(1_350),
            energyPermille: z.number().int().min(0).max(1_000),
            pronunciation: z.record(z.string(), z.string()),
          })
          .strict(),
      )
      .min(1)
      .max(MAXIMUM_RENDER_JOBS),
  })
  .strict();

const QwenProgressSchema = z
  .object({
    type: z.literal('qwen-progress'),
    operation: z.literal('render'),
    stage: z.literal('quality-checked'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    completed: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    total: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
  })
  .strict();

const QwenRetrySchema = z
  .object({
    type: z.literal('qwen-retry'),
    operation: z.literal('render'),
    stage: z.literal('quality-retry'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    attempt: z.number().int().min(2).max(10),
    maximumAttempts: z.number().int().min(2).max(10),
    seed: z.number().int().min(0).max(2_147_483_647),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine(({ attempt, maximumAttempts }) => attempt <= maximumAttempts);

const QwenDeferredSchema = z
  .object({
    type: z.literal('qwen-deferred'),
    operation: z.literal('render'),
    stage: z.literal('quality-deferred'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    parkedCount: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    attempt: z.number().int().min(1).max(32),
    maximumAttempts: z.number().int().min(1).max(32),
    profile: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine(({ attempt, maximumAttempts }) => attempt <= maximumAttempts);

const QwenRescueStartedSchema = z
  .object({
    type: z.literal('qwen-rescue'),
    operation: z.literal('render'),
    stage: z.literal('started'),
    parkedCount: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    rescueTotal: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    maximumAttempts: z.number().int().min(1).max(32),
  })
  .strict()
  .refine(({ rescueTotal, maximumAttempts }) => maximumAttempts === rescueTotal + 1);

const QwenRescueAttemptSchema = z
  .object({
    type: z.literal('qwen-rescue'),
    operation: z.literal('render'),
    stage: z.literal('attempt'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    rescueIndex: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    rescueTotal: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    attempt: z.number().int().min(1).max(32),
    maximumAttempts: z.number().int().min(1).max(32),
    profile: z.string().trim().min(1).max(160),
    seed: z.number().int().min(0).max(2_147_483_647),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine(
    ({ rescueIndex, rescueTotal, attempt, maximumAttempts }) =>
      rescueIndex <= rescueTotal &&
      attempt === rescueIndex + 1 &&
      maximumAttempts === rescueTotal + 1,
  );

const QwenRescueRecoveredSchema = z
  .object({
    type: z.literal('qwen-rescue'),
    operation: z.literal('render'),
    stage: z.literal('recovered'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    attempt: z.number().int().min(1).max(32),
    profile: z.string().trim().min(1).max(160),
    remainingParked: z.number().int().min(0).max(MAXIMUM_RENDER_JOBS),
  })
  .strict();

const QwenRescueExhaustedSchema = z
  .object({
    type: z.literal('qwen-rescue'),
    operation: z.literal('render'),
    stage: z.literal('exhausted'),
    cueId: z.string().regex(SAFE_CUE_ID_PATTERN),
    attempts: z.number().int().min(1).max(32),
    lastReason: z.string().trim().min(1).max(2_000),
  })
  .strict();

const QwenRescueCompleteSchema = z
  .object({
    type: z.literal('qwen-rescue'),
    operation: z.literal('render'),
    stage: z.literal('complete'),
    recoveredCount: z.number().int().min(0).max(MAXIMUM_RENDER_JOBS),
    failedCount: z.number().int().min(0).max(MAXIMUM_RENDER_JOBS),
  })
  .strict()
  .refine(({ recoveredCount, failedCount }) => recoveredCount + failedCount > 0);

const QwenRescueSchema = z.discriminatedUnion('stage', [
  QwenRescueStartedSchema,
  QwenRescueAttemptSchema,
  QwenRescueRecoveredSchema,
  QwenRescueExhaustedSchema,
  QwenRescueCompleteSchema,
]);

export function qwenRescueCompletionMatches(
  parkedCount: number,
  recoveredCueCount: number,
  exhaustedCueCount: number,
  reported: { recoveredCount: number; failedCount: number },
): boolean {
  return (
    reported.recoveredCount === recoveredCueCount &&
    reported.failedCount === exhaustedCueCount &&
    reported.recoveredCount + reported.failedCount === parkedCount
  );
}

const QwenCompleteSchema = z
  .object({
    type: z.literal('qwen-complete'),
    operation: z.literal('render'),
    cueCount: z.number().int().min(1).max(MAXIMUM_RENDER_JOBS),
    qaReport: z.string().trim().min(1),
  })
  .strict();

const QwenErrorSchema = z
  .object({
    type: z.literal('qwen-error'),
    errorType: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

type QwenRuntimeManifest = z.infer<typeof QwenRuntimeManifestSchema>;
type VoiceApproval = z.infer<typeof VoiceApprovalSchema>;
type GenericWorkerManifest = z.infer<typeof GenericWorkerManifestSchema>;

export interface QwenRendererOptions {
  runtimeManifestPath: string;
  approvalPath: string;
  baseModelPath: string;
  asrModelPath: string;
}

export interface QwenWorkerRunnerOptions extends QwenRendererOptions {
  pythonPath: string;
}

export interface QwenVoiceAdapter {
  workerPath: string;
  renderer: VoiceRendererConfig;
  runWorker: VoiceWorkerRunner;
}

interface VerifiedQwenResources {
  runtimeManifestPath: string;
  runtimeManifest: QwenRuntimeManifest;
  runtimeManifestSha256: string;
  approvalPath: string;
  approval: VoiceApproval;
  approvalSha256: string;
  referencePath: string;
  referenceSha256: string;
  baseModelPath: string;
  asrModelPath: string;
}

export interface QwenRenderManifest {
  protocolVersion: 1;
  operation: 'render';
  runtimeManifestPath: string;
  voiceApprovalPath: string;
  baseModelPath: string;
  asrModelPath: string;
  qaReportPath: string;
  renderPolicyRevision: typeof QWEN_RENDER_POLICY_REVISION;
  baseSeed: number;
  generation: typeof QWEN_GENERATION;
  jobs: Array<{
    cueId: string;
    cacheKey: string;
    outputPath: string;
    text: string;
    qaTranscript: string;
    language: 'English';
  }>;
}

export interface AdaptedQwenWorkerBatch {
  manifest: QwenRenderManifest;
  cueIdsByRenderCueId: ReadonlyMap<string, readonly string[]>;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    const source = await readFile(path, 'utf8');
    return JSON.parse(source.replace(/^\uFEFF/u, '')) as unknown;
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error instanceof Error ? error.message : error}`);
  }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a regular file');
  } catch (error) {
    throw new Error(`${label} is missing or invalid at "${path}".`, { cause: error });
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`${label} is missing or invalid at "${path}".`, { cause: error });
  }
}

async function verifyModelDirectory(
  path: string,
  expected: QwenRuntimeManifest['models']['base'],
  label: string,
): Promise<void> {
  await requireDirectory(path, `${label} model directory`);
  const markerPath = resolve(path, MODEL_MARKER_NAME);
  const parsed = ModelMarkerSchema.safeParse(await readJson(markerPath, `${label} model marker`));
  if (!parsed.success) {
    throw new Error(`${label} model marker is invalid: ${z.prettifyError(parsed.error)}`);
  }
  if (
    parsed.data.repository !== expected.repository ||
    parsed.data.revision !== expected.revision
  ) {
    throw new Error(`${label} model does not match the pinned Qwen runtime revision.`);
  }
}

async function verifyQwenResources(options: QwenRendererOptions): Promise<VerifiedQwenResources> {
  const runtimeManifestPath = resolve(options.runtimeManifestPath);
  const approvalPath = resolve(options.approvalPath);
  const baseModelPath = resolve(options.baseModelPath);
  const asrModelPath = resolve(options.asrModelPath);

  await requireRegularFile(runtimeManifestPath, 'Qwen runtime manifest');
  await requireRegularFile(approvalPath, 'Approved Qwen voice document');

  const runtimeBytes = await readFile(runtimeManifestPath);
  const runtimeResult = QwenRuntimeManifestSchema.safeParse(
    await readJson(runtimeManifestPath, 'Qwen runtime manifest'),
  );
  if (!runtimeResult.success) {
    throw new Error(`Qwen runtime manifest is invalid: ${z.prettifyError(runtimeResult.error)}`);
  }

  const approvalBytes = await readFile(approvalPath);
  const approvalResult = VoiceApprovalSchema.safeParse(
    await readJson(approvalPath, 'Approved Qwen voice document'),
  );
  if (!approvalResult.success) {
    throw new Error(
      `Approved Qwen voice document is invalid: ${z.prettifyError(approvalResult.error)}`,
    );
  }

  const referenceFile = approvalResult.data.reference.file;
  if (basename(referenceFile) !== referenceFile) {
    throw new Error('Approved Qwen reference must be a file beside its approval document.');
  }
  const referencePath = resolve(dirname(approvalPath), referenceFile);
  await requireRegularFile(referencePath, 'Approved Qwen reference WAV');
  const referenceSha256 = sha256(await readFile(referencePath));
  if (referenceSha256 !== approvalResult.data.reference.sha256) {
    throw new Error('Approved Qwen reference failed its exact SHA-256 integrity check.');
  }

  await verifyModelDirectory(baseModelPath, runtimeResult.data.models.base, 'Qwen Base');
  await verifyModelDirectory(asrModelPath, runtimeResult.data.models.asr, 'Qwen ASR');

  return {
    runtimeManifestPath,
    runtimeManifest: runtimeResult.data,
    runtimeManifestSha256: sha256(runtimeBytes),
    approvalPath,
    approval: approvalResult.data,
    approvalSha256: sha256(approvalBytes),
    referencePath,
    referenceSha256,
    baseModelPath,
    asrModelPath,
  };
}

export async function createQwenRendererConfig(
  options: QwenRendererOptions,
): Promise<VoiceRendererConfig> {
  const resources = await verifyQwenResources(options);
  const runtime = resources.runtimeManifest;

  return {
    engineId: 'qwen3-tts',
    modelRevision: [
      `${runtime.models.base.repository}@${runtime.models.base.revision}`,
      `${runtime.models.asr.repository}@${runtime.models.asr.revision}`,
      `qwen-tts-${runtime.packages.qwenTts}`,
      `transformers-${runtime.packages.transformers}`,
    ].join(':'),
    deliveryPresetRevision: 'yaw-qwen-natural-delivery-v1',
    pronunciationRevision: 'whole-token-substitution-v2',
    postProcessingRevision: [
      `digital-silence-guard-${runtime.qa.silentGuardMs}ms`,
      'no-trim',
      'no-fade',
      'no-normalization',
      'no-tempo',
      'no-pitch',
      runtime.qa.policyRevision,
    ].join(':'),
    voiceName: resources.approval.voiceName,
    voiceProfileHashSource: canonicalJson({
      engine: 'qwen3-tts',
      voiceId: resources.approval.voiceId,
      approvedAsRendered: true,
      approvalSha256: resources.approvalSha256,
      referenceSha256: resources.referenceSha256,
      referenceTranscript: resources.approval.reference.transcript,
      runtimeManifestSha256: resources.runtimeManifestSha256,
      baseModel: runtime.models.base,
      asrModel: runtime.models.asr,
      generation: QWEN_GENERATION,
      baseSeed: QWEN_RENDER_BASE_SEED,
      renderPolicyRevision: QWEN_RENDER_POLICY_REVISION,
    }),
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function applyQwenPronunciation(
  text: string,
  pronunciation: Record<string, string>,
): string {
  let spoken = text;
  const entries = Object.entries(pronunciation).sort(
    ([writtenA], [writtenB]) => writtenB.length - writtenA.length,
  );
  for (const [written, replacement] of entries) {
    const normalizedWritten = written.normalize('NFKC').trim();
    const normalizedReplacement = replacement.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!normalizedWritten || !normalizedReplacement) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegularExpression(normalizedWritten)}(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    spoken = spoken.replace(pattern, () => normalizedReplacement);
  }
  return spoken.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function adaptVoiceWorkerManifestForQwen(
  manifest: VoiceWorkerManifest,
  resources: QwenRendererOptions,
  qaReportPath: string,
): QwenRenderManifest {
  return adaptVoiceWorkerBatchForQwen(manifest, resources, qaReportPath).manifest;
}

function outputPathIdentity(outputPath: string): string {
  return process.platform === 'win32' ? outputPath.toLowerCase() : outputPath;
}

export function adaptVoiceWorkerBatchForQwen(
  manifest: VoiceWorkerManifest,
  resources: QwenRendererOptions,
  qaReportPath: string,
): AdaptedQwenWorkerBatch {
  const parsed = GenericWorkerManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`Generic voice render manifest is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const cueIds = new Set<string>();
  const groupsByOutput = new Map<
    string,
    {
      signature: string;
      renderJob: QwenRenderManifest['jobs'][number];
      cueIds: string[];
    }
  >();
  for (const job of parsed.data.jobs) {
    if (cueIds.has(job.cueId)) {
      throw new Error(`Generic voice render manifest repeats cue "${job.cueId}".`);
    }
    cueIds.add(job.cueId);
    const outputPath = resolve(job.outputPath);
    const spokenText = applyQwenPronunciation(job.text, job.pronunciation);
    const renderJob = {
      cueId: job.cueId,
      cacheKey: job.cacheKey,
      outputPath,
      text: spokenText,
      qaTranscript: spokenText,
      language: 'English' as const,
    };
    const signature = canonicalJson({
      text: job.text.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
      cacheKey: job.cacheKey,
      spokenText,
      delivery: job.delivery,
      pacePermille: job.pacePermille,
      energyPermille: job.energyPermille,
      pronunciation: job.pronunciation,
    });
    const outputIdentity = outputPathIdentity(outputPath);
    const existing = groupsByOutput.get(outputIdentity);
    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(
          `Generic voice render manifest reuses output "${outputPath}" for different render content.`,
        );
      }
      existing.cueIds.push(job.cueId);
    } else {
      groupsByOutput.set(outputIdentity, {
        signature,
        renderJob,
        cueIds: [job.cueId],
      });
    }
  }

  const groups = [...groupsByOutput.values()];
  return {
    manifest: {
      protocolVersion: 1,
      operation: 'render',
      runtimeManifestPath: resolve(resources.runtimeManifestPath),
      voiceApprovalPath: resolve(resources.approvalPath),
      baseModelPath: resolve(resources.baseModelPath),
      asrModelPath: resolve(resources.asrModelPath),
      qaReportPath: resolve(qaReportPath),
      renderPolicyRevision: QWEN_RENDER_POLICY_REVISION,
      baseSeed: QWEN_RENDER_BASE_SEED,
      generation: QWEN_GENERATION,
      jobs: groups.map((group) => group.renderJob),
    },
    cueIdsByRenderCueId: new Map(
      groups.map((group) => [group.renderJob.cueId, group.cueIds] as const),
    ),
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function conciseQwenFailureFromStderr(stderr: string): string | null {
  const errorLinePattern = /^(?:[\w.]*Error|Exception|QwenVoiceError):\s*(?<message>.+)$/u;
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const match = errorLinePattern.exec(line);
    const message = match?.groups?.message?.trim();
    if (message) return message.slice(0, 2_000);
  }
  return null;
}

export function qwenWorkerFailureMessage(
  code: number | null,
  typedMessage: string | null,
  stderr: string,
  diagnosticLogPath: string,
): string {
  const reason =
    typedMessage?.trim() ||
    conciseQwenFailureFromStderr(stderr) ||
    'The offline voice worker stopped unexpectedly.';
  return (
    `Voice cooking stopped (worker code ${code ?? 'unknown'}) after saving every clip that ` +
    `already passed quality checks. ${reason} Restart the app and cook again to resume. ` +
    `Full diagnostic log: "${diagnosticLogPath}".`
  );
}

export function qwenProgressFromMessage(message: unknown): WorkerProgress | null {
  const progress = QwenProgressSchema.safeParse(message);
  if (progress.success) {
    return {
      type: 'progress',
      cueId: progress.data.cueId,
      cached: false,
    };
  }
  const retry = QwenRetrySchema.safeParse(message);
  if (retry.success) {
    return {
      type: 'activity',
      activity: {
        type: 'quality-retry',
        attempt: retry.data.attempt,
        maximumAttempts: retry.data.maximumAttempts,
      },
    };
  }
  const deferred = QwenDeferredSchema.safeParse(message);
  if (deferred.success) {
    return {
      type: 'activity',
      activity: {
        type: 'quality-deferred',
        parkedCount: deferred.data.parkedCount,
      },
    };
  }
  const rescue = QwenRescueSchema.safeParse(message);
  if (!rescue.success) return null;
  switch (rescue.data.stage) {
    case 'started':
      return {
        type: 'activity',
        activity: {
          type: 'quality-rescue-started',
          parkedCount: rescue.data.parkedCount,
          rescueTotal: rescue.data.rescueTotal,
          maximumAttempts: rescue.data.maximumAttempts,
        },
      };
    case 'attempt':
      return {
        type: 'activity',
        activity: {
          type: 'quality-rescue-attempt',
          rescueIndex: rescue.data.rescueIndex,
          rescueTotal: rescue.data.rescueTotal,
          attempt: rescue.data.attempt,
          maximumAttempts: rescue.data.maximumAttempts,
        },
      };
    case 'recovered':
      return {
        type: 'activity',
        activity: {
          type: 'quality-rescue-recovered',
          remainingParked: rescue.data.remainingParked,
        },
      };
    case 'exhausted':
      return {
        type: 'activity',
        activity: {
          type: 'quality-rescue-exhausted',
          attempts: rescue.data.attempts,
        },
      };
    case 'complete':
      return {
        type: 'activity',
        activity: {
          type: 'quality-rescue-complete',
          recoveredCount: rescue.data.recoveredCount,
          failedCount: rescue.data.failedCount,
        },
      };
  }
}

export function createQwenVoiceWorkerRunner(options: QwenWorkerRunnerOptions): VoiceWorkerRunner {
  const pythonPath = resolve(options.pythonPath);
  const resources: QwenRendererOptions = {
    runtimeManifestPath: resolve(options.runtimeManifestPath),
    approvalPath: resolve(options.approvalPath),
    baseModelPath: resolve(options.baseModelPath),
    asrModelPath: resolve(options.asrModelPath),
  };

  return async (workerPath, genericManifestPath, onProgress) => {
    await requireRegularFile(pythonPath, 'Qwen Python runtime');
    await requireRegularFile(resolve(workerPath), 'Qwen voice worker');
    await verifyQwenResources(resources);

    const genericManifestResult = GenericWorkerManifestSchema.safeParse(
      await readJson(resolve(genericManifestPath), 'Generic voice render manifest'),
    );
    if (!genericManifestResult.success) {
      throw new Error(
        `Generic voice render manifest is invalid: ${z.prettifyError(genericManifestResult.error)}`,
      );
    }
    const genericManifest = genericManifestResult.data as GenericWorkerManifest;
    const adaptedManifestPath = resolve(
      dirname(genericManifestPath),
      `qwen-render-${randomUUID()}.json`,
    );
    const qaReportPath = resolve(dirname(genericManifestPath), `qwen-qa-${randomUUID()}.json`);
    const diagnosticLogPath = resolve(dirname(genericManifestPath), 'voice-cook-latest.log');
    const adaptedBatch = adaptVoiceWorkerBatchForQwen(genericManifest, resources, qaReportPath);
    const adaptedManifest = adaptedBatch.manifest;

    try {
      await Promise.all([
        writeFile(adaptedManifestPath, JSON.stringify(adaptedManifest), {
          encoding: 'utf8',
          flag: 'wx',
        }),
        writeFile(diagnosticLogPath, '', {
          encoding: 'utf8',
          flag: 'w',
        }),
      ]);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const diagnosticLog = createWriteStream(diagnosticLogPath, {
          encoding: 'utf8',
          flags: 'a',
        });
        const child = spawn(
          pythonPath,
          ['-I', resolve(workerPath), '--manifest', adaptedManifestPath],
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
              PYTHONNOUSERSITE: '1',
              PYTHONUTF8: '1',
            },
          },
        );
        const expectedCueIds = new Set(adaptedManifest.jobs.map((job) => job.cueId));
        const reportedCueIds = new Set<string>();
        const latestRetryAttemptByCueId = new Map<string, number>();
        const deferredCueIds = new Set<string>();
        const latestRescueIndexByCueId = new Map<string, number>();
        const latestRescueAttemptByCueId = new Map<string, number>();
        const rescuedCueIds = new Set<string>();
        const exhaustedCueIds = new Set<string>();
        let rescueTotal: number | null = null;
        let rescueParkedCount: number | null = null;
        let rescueCompleteSeen = false;
        let completionSeen = false;
        let protocolError: Error | null = null;
        let diagnosticLogError: Error | null = null;
        let typedWorkerError: z.infer<typeof QwenErrorSchema> | null = null;
        let launchError: Error | null = null;
        let stderr = '';
        let settled = false;

        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) rejectPromise(error);
          else resolvePromise();
        };

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          diagnosticLog.write(chunk);
          stderr += chunk;
          if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
        });
        diagnosticLog.on('error', (error) => {
          diagnosticLogError ??= new Error(
            `The voice diagnostic log could not be written: ${error.message}`,
          );
          child.kill();
        });

        const output = createInterface({ input: child.stdout });
        output.on('line', (line) => {
          diagnosticLog.write(`[protocol] ${line}\n`);
          const message = parseJsonLine(line);
          if (!message || typeof message !== 'object') return;
          const type = (message as { type?: unknown }).type;
          if (type === 'qwen-progress') {
            const parsed = QwenProgressSchema.safeParse(message);
            if (!parsed.success) {
              protocolError ??= new Error('Qwen worker emitted malformed per-cue progress.');
              return;
            }
            if (
              parsed.data.total !== expectedCueIds.size ||
              parsed.data.completed !== reportedCueIds.size + 1 ||
              !expectedCueIds.has(parsed.data.cueId) ||
              reportedCueIds.has(parsed.data.cueId)
            ) {
              protocolError ??= new Error('Qwen worker emitted inconsistent per-cue progress.');
              return;
            }
            reportedCueIds.add(parsed.data.cueId);
            try {
              const originalCueIds = adaptedBatch.cueIdsByRenderCueId.get(parsed.data.cueId);
              if (!originalCueIds?.length) {
                throw new Error(
                  `Qwen worker progress has no source cues for "${parsed.data.cueId}".`,
                );
              }
              for (const cueId of originalCueIds) {
                onProgress({
                  type: 'progress',
                  cueId,
                  cached: false,
                });
              }
            } catch (error) {
              protocolError ??= error instanceof Error ? error : new Error(String(error));
            }
          } else if (type === 'qwen-retry') {
            const parsed = QwenRetrySchema.safeParse(message);
            if (!parsed.success) {
              protocolError ??= new Error('Qwen worker emitted malformed retry activity.');
              return;
            }
            const previousAttempt = latestRetryAttemptByCueId.get(parsed.data.cueId) ?? 1;
            if (
              !expectedCueIds.has(parsed.data.cueId) ||
              reportedCueIds.has(parsed.data.cueId) ||
              parsed.data.attempt !== previousAttempt + 1
            ) {
              protocolError ??= new Error('Qwen worker emitted inconsistent retry activity.');
              return;
            }
            latestRetryAttemptByCueId.set(parsed.data.cueId, parsed.data.attempt);
            onProgress({
              type: 'activity',
              activity: {
                type: 'quality-retry',
                attempt: parsed.data.attempt,
                maximumAttempts: parsed.data.maximumAttempts,
              },
            });
          } else if (type === 'qwen-deferred') {
            const parsed = QwenDeferredSchema.safeParse(message);
            if (!parsed.success) {
              protocolError ??= new Error('Qwen worker emitted malformed deferred activity.');
              return;
            }
            if (
              !expectedCueIds.has(parsed.data.cueId) ||
              reportedCueIds.has(parsed.data.cueId) ||
              deferredCueIds.has(parsed.data.cueId) ||
              parsed.data.parkedCount !== deferredCueIds.size + 1
            ) {
              protocolError ??= new Error('Qwen worker emitted inconsistent deferred activity.');
              return;
            }
            deferredCueIds.add(parsed.data.cueId);
            const activity = qwenProgressFromMessage(message);
            if (!activity || activity.type !== 'activity') {
              protocolError ??= new Error('Qwen deferred activity could not be normalized.');
              return;
            }
            onProgress(activity);
          } else if (type === 'qwen-rescue') {
            const parsed = QwenRescueSchema.safeParse(message);
            if (!parsed.success) {
              protocolError ??= new Error('Qwen worker emitted malformed rescue activity.');
              return;
            }
            let consistent = true;
            switch (parsed.data.stage) {
              case 'started':
                consistent =
                  rescueTotal === null &&
                  rescueParkedCount === null &&
                  !rescueCompleteSeen &&
                  parsed.data.parkedCount === deferredCueIds.size &&
                  parsed.data.maximumAttempts === parsed.data.rescueTotal + 1;
                if (consistent) {
                  rescueTotal = parsed.data.rescueTotal;
                  rescueParkedCount = parsed.data.parkedCount;
                }
                break;
              case 'attempt': {
                const previousRescueIndex = latestRescueIndexByCueId.get(parsed.data.cueId) ?? 0;
                consistent =
                  rescueTotal !== null &&
                  parsed.data.rescueTotal === rescueTotal &&
                  deferredCueIds.has(parsed.data.cueId) &&
                  !rescuedCueIds.has(parsed.data.cueId) &&
                  !exhaustedCueIds.has(parsed.data.cueId) &&
                  parsed.data.rescueIndex === previousRescueIndex + 1 &&
                  parsed.data.attempt === parsed.data.rescueIndex + 1 &&
                  parsed.data.maximumAttempts === parsed.data.rescueTotal + 1 &&
                  latestRetryAttemptByCueId.get(parsed.data.cueId) === parsed.data.attempt;
                if (consistent) {
                  latestRescueIndexByCueId.set(parsed.data.cueId, parsed.data.rescueIndex);
                  latestRescueAttemptByCueId.set(parsed.data.cueId, parsed.data.attempt);
                }
                break;
              }
              case 'recovered':
                consistent =
                  rescueTotal !== null &&
                  deferredCueIds.has(parsed.data.cueId) &&
                  !rescuedCueIds.has(parsed.data.cueId) &&
                  !exhaustedCueIds.has(parsed.data.cueId) &&
                  latestRescueAttemptByCueId.get(parsed.data.cueId) === parsed.data.attempt &&
                  parsed.data.remainingParked ===
                    deferredCueIds.size - rescuedCueIds.size - exhaustedCueIds.size - 1;
                if (consistent) rescuedCueIds.add(parsed.data.cueId);
                break;
              case 'exhausted':
                consistent =
                  rescueTotal !== null &&
                  deferredCueIds.has(parsed.data.cueId) &&
                  !rescuedCueIds.has(parsed.data.cueId) &&
                  !exhaustedCueIds.has(parsed.data.cueId) &&
                  latestRescueAttemptByCueId.get(parsed.data.cueId) === parsed.data.attempts;
                if (consistent) exhaustedCueIds.add(parsed.data.cueId);
                break;
              case 'complete':
                consistent =
                  rescueTotal !== null &&
                  rescueParkedCount !== null &&
                  !rescueCompleteSeen &&
                  qwenRescueCompletionMatches(
                    rescueParkedCount,
                    rescuedCueIds.size,
                    exhaustedCueIds.size,
                    parsed.data,
                  );
                if (consistent) rescueCompleteSeen = true;
                break;
            }
            if (!consistent) {
              protocolError ??= new Error('Qwen worker emitted inconsistent rescue activity.');
              return;
            }
            const activity = qwenProgressFromMessage(message);
            if (!activity || activity.type !== 'activity') {
              protocolError ??= new Error('Qwen rescue activity could not be normalized.');
              return;
            }
            onProgress(activity);
          } else if (type === 'qwen-complete') {
            const parsed = QwenCompleteSchema.safeParse(message);
            if (
              !parsed.success ||
              parsed.data.cueCount !== expectedCueIds.size ||
              resolve(parsed.data.qaReport) !== qaReportPath ||
              completionSeen ||
              (deferredCueIds.size > 0 && !rescueCompleteSeen)
            ) {
              protocolError ??= new Error('Qwen worker emitted an invalid completion message.');
              return;
            }
            completionSeen = true;
          } else if (type === 'qwen-error') {
            const parsed = QwenErrorSchema.safeParse(message);
            if (!parsed.success || typedWorkerError) {
              protocolError ??= new Error('Qwen worker emitted an invalid error message.');
              return;
            }
            typedWorkerError = parsed.data;
          }
        });

        child.once('error', (error) => {
          launchError = error;
          diagnosticLog.write(`[launcher-error] ${error.stack ?? error.message}\n`);
        });
        child.once('close', (code) => {
          output.close();
          const finish = () => {
            if (launchError) {
              settle(launchError);
              return;
            }
            if (diagnosticLogError) {
              settle(diagnosticLogError);
              return;
            }
            if (code !== 0) {
              settle(
                new Error(
                  qwenWorkerFailureMessage(
                    code,
                    typedWorkerError?.message ?? null,
                    stderr,
                    diagnosticLogPath,
                  ),
                ),
              );
              return;
            }
            if (protocolError) {
              settle(protocolError);
              return;
            }
            if (typedWorkerError) {
              settle(new Error('Qwen worker reported an error but exited successfully.'));
              return;
            }
            if (!completionSeen || reportedCueIds.size !== expectedCueIds.size) {
              settle(new Error('Qwen voice worker exited without complete per-cue QA results.'));
              return;
            }
            settle();
          };
          if (diagnosticLog.closed) finish();
          else {
            diagnosticLog.once('close', finish);
            diagnosticLog.end();
          }
        });
      });
    } finally {
      await Promise.all([
        unlink(adaptedManifestPath).catch(() => undefined),
        unlink(qaReportPath).catch(() => undefined),
      ]);
    }
  };
}

function requiredEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  name: (typeof QWEN_ENVIRONMENT_PATHS)[keyof typeof QWEN_ENVIRONMENT_PATHS],
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Qwen3-TTS requires the explicit ${name} setting.`);
  return resolve(value);
}

export async function createQwenVoiceAdapterFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<QwenVoiceAdapter> {
  const workerPath = requiredEnvironmentPath(environment, QWEN_ENVIRONMENT_PATHS.worker);
  const pythonPath = requiredEnvironmentPath(environment, QWEN_ENVIRONMENT_PATHS.python);
  const options: QwenRendererOptions = {
    baseModelPath: requiredEnvironmentPath(environment, QWEN_ENVIRONMENT_PATHS.baseModel),
    asrModelPath: requiredEnvironmentPath(environment, QWEN_ENVIRONMENT_PATHS.asrModel),
    approvalPath: requiredEnvironmentPath(environment, QWEN_ENVIRONMENT_PATHS.approval),
    runtimeManifestPath: requiredEnvironmentPath(
      environment,
      QWEN_ENVIRONMENT_PATHS.runtimeManifest,
    ),
  };

  await requireRegularFile(workerPath, 'Qwen voice worker');
  await requireRegularFile(pythonPath, 'Qwen Python runtime');
  const renderer = await createQwenRendererConfig(options);
  return {
    workerPath,
    renderer,
    runWorker: createQwenVoiceWorkerRunner({ ...options, pythonPath }),
  };
}
