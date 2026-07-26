import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  QWEN_RUNTIME_MANIFEST,
  QWEN_RUNTIME_MANIFEST_SHA256,
  deterministicQwenModelCachePath,
  inspectQwenRuntime,
  type QwenRuntimeProbe,
} from './qwen-runtime.js';
import {
  verifyPackagedHostVoiceProfile,
  verifyPackagedVoiceResource,
} from './packaged-voice-resources.js';

export {
  deterministicQwenEnvironmentPath,
  deterministicQwenModelCachePath,
  deterministicQwenModelPath,
  deterministicQwenPythonPath,
  deterministicQwenReceiptPath,
} from './qwen-runtime.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const UNSAFE_WINDOWS_FILENAME_CHARACTER = /[<>:"|?*\u0000-\u001f]/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/iu;
const MINIMUM_REFERENCE_DURATION_MS = 5_000;
const MAXIMUM_REFERENCE_DURATION_MS = 30_000;
const MAXIMUM_REFERENCE_BYTES = 25 * 1024 * 1024;
const MAXIMUM_REFERENCE_TRANSCRIPT_CHARACTERS = 4_000;
const APPROVAL_FILE_NAME = 'approval.json';

const ReferenceIdentitySchema = z
  .object({
    file: z.string().trim().min(1).max(240),
    sha256: z.string().regex(SHA256_PATTERN),
    transcript: z.string().trim().min(1).max(MAXIMUM_REFERENCE_TRANSCRIPT_CHARACTERS),
  })
  .strict();

const DesktopVoiceProfileSchema = z
  .object({
    schemaVersion: z.literal(2),
    engine: z.literal('qwen3-tts'),
    model: z.literal('base-0.6b'),
    voiceId: z.string().regex(SAFE_ID),
    voiceName: z.string().trim().min(1).max(100),
    reference: ReferenceIdentitySchema,
  })
  .strict();

const DesktopVoiceApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('approved'),
    engine: z.literal('qwen3-tts'),
    syntheticOriginal: z.literal(true),
    voiceId: z.string().regex(SAFE_ID),
    voiceName: z.string().trim().min(1).max(100),
    approvedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
      message: 'approvedAt must be an ISO timestamp.',
    }),
    approvedAsRendered: z.literal(true),
    reference: ReferenceIdentitySchema,
    audition: z
      .object({
        candidateId: z.string().regex(SAFE_ID),
        seed: z.number().int().min(0).max(2_147_483_647),
        transcriptWordErrorRate: z
          .number()
          .min(0)
          .max(QWEN_RUNTIME_MANIFEST.qa.maximumWordErrorRate),
        onsetMilliseconds: z
          .number()
          .int()
          .min(QWEN_RUNTIME_MANIFEST.qa.silentGuardMs)
          .max(QWEN_RUNTIME_MANIFEST.qa.maximumEdgeSilenceMs),
      })
      .strict(),
  })
  .strict();

export type DesktopVoiceProfile = z.infer<typeof DesktopVoiceProfileSchema>;
export type DesktopVoiceApproval = z.infer<typeof DesktopVoiceApprovalSchema>;
export type DesktopVoiceProfileSource = 'development' | 'persisted' | 'bundled';

export interface QwenDesktopVoice {
  kind: 'qwen3-tts';
  source: DesktopVoiceProfileSource;
  profile: DesktopVoiceProfile;
  approval: DesktopVoiceApproval;
  approvalPath: string;
  approvalSha256: string;
  referencePath: string;
  referenceSha256: string;
  pythonPath: string;
  modelCachePath: string;
  baseModelPath: string;
  asrModelPath: string;
  baseModelRevision: string;
  asrModelRevision: string;
  runtimeManifestPath: string;
  workerPath: string;
  device: 'cuda' | 'cpu';
}

export interface SystemSpeechDesktopVoice {
  kind: 'system-speech';
  source: 'development';
  workerPath: string;
}

export interface UnavailableDesktopVoice {
  kind: 'unavailable';
  message: string;
}

export type DesktopVoiceSelection =
  QwenDesktopVoice | SystemSpeechDesktopVoice | UnavailableDesktopVoice;

export interface ResolveDesktopVoiceOptions {
  environment: NodeJS.ProcessEnv;
  allowDevelopmentOverride: boolean;
  isPackaged: boolean;
  projectRoot: string;
  resourcesPath: string;
  userDataDirectory: string;
  qwenWorkerPath: string;
  qwenRuntimeManifestPath: string;
  systemWorkerPath: string;
  persistedProfilePath?: string;
  bundledProfilePath?: string;
  runtimeProbe?: QwenRuntimeProbe;
}

export interface BuildRuntimeVoiceEnvironmentOptions {
  inheritedEnvironment: NodeJS.ProcessEnv;
  selection: DesktopVoiceSelection;
  voiceCachePath: string;
}

export interface VerifiedDesktopVoiceProfile {
  profile: DesktopVoiceProfile;
  profilePath: string;
  approval: DesktopVoiceApproval;
  approvalPath: string;
  approvalSha256: string;
  referencePath: string;
  approvalReferencePath: string;
  referenceSha256: string;
}

export type DesktopVoiceProfileInspection =
  | {
      found: false;
    }
  | {
      found: true;
      verified: VerifiedDesktopVoiceProfile;
    }
  | {
      found: true;
      error: string;
    };

interface ProfileSelectionInspection {
  found: boolean;
  selection?: QwenDesktopVoice;
  error?: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pinnedDevelopmentModel(path: string, kind: 'base' | 'asr'): Promise<boolean> {
  try {
    const marker = JSON.parse(
      (await readFile(join(path, '.yaw-model.json'), 'utf8')).replace(/^\uFEFF/u, ''),
    ) as { repository?: unknown; revision?: unknown };
    const pin = QWEN_RUNTIME_MANIFEST.models[kind];
    return marker.repository === pin.repository && marker.revision === pin.revision;
  } catch {
    return false;
  }
}

function containedProfileFilePath(profilePath: string, file: string, extension: string): string {
  const segments = file.split('/');
  if (
    isAbsolute(file) ||
    file.includes('\0') ||
    file.includes('\\') ||
    !file.toLowerCase().endsWith(extension) ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_RESERVED_NAME.test(segment) ||
        UNSAFE_WINDOWS_FILENAME_CHARACTER.test(segment),
    )
  ) {
    throw new Error(
      `The approved profile must name a safe relative ${extension.toUpperCase()} file.`,
    );
  }

  const root = resolve(dirname(profilePath));
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('An approved profile file escaped the voice profile directory.');
  }
  return target;
}

async function verifyRealContainment(profilePath: string, targetPath: string): Promise<void> {
  const root = await realpath(dirname(profilePath));
  const target = await realpath(targetPath);
  const fromRoot = relative(root, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('An approved profile file resolves outside the voice profile directory.');
  }
}

function referenceWaveDurationMs(buffer: Buffer): number {
  if (
    buffer.length < 44 ||
    buffer.length > MAXIMUM_REFERENCE_BYTES ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('The approved host reference must be a bounded RIFF/WAVE file.');
  }
  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd !== buffer.length) {
    throw new Error('The approved host reference has an invalid RIFF container size.');
  }

  let byteRate: number | null = null;
  let blockAlign: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) {
      throw new Error('The approved host reference has a truncated chunk header.');
    }
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    const contentEnd = contentOffset + chunkSize;
    const paddedEnd = contentEnd + (chunkSize % 2);
    if (paddedEnd > riffEnd) {
      throw new Error(`The approved host reference has a truncated "${chunkId}" chunk.`);
    }
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || byteRate !== null) {
        throw new Error('The approved host reference has an invalid PCM format chunk.');
      }
      const encoding = buffer.readUInt16LE(contentOffset);
      const channels = buffer.readUInt16LE(contentOffset + 2);
      const sampleRate = buffer.readUInt32LE(contentOffset + 4);
      const parsedByteRate = buffer.readUInt32LE(contentOffset + 8);
      const parsedBlockAlign = buffer.readUInt16LE(contentOffset + 12);
      const bitsPerSample = buffer.readUInt16LE(contentOffset + 14);
      if (
        (encoding !== 1 && encoding !== 3) ||
        channels < 1 ||
        channels > 2 ||
        sampleRate < 8_000 ||
        sampleRate > 192_000 ||
        (encoding === 3 && bitsPerSample !== 32) ||
        (encoding === 1 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) ||
        parsedBlockAlign === 0 ||
        parsedByteRate !== sampleRate * parsedBlockAlign ||
        parsedBlockAlign !== channels * (bitsPerSample / 8)
      ) {
        throw new Error('The approved host reference uses an unsupported WAV format.');
      }
      byteRate = parsedByteRate;
      blockAlign = parsedBlockAlign;
    } else if (chunkId === 'data') {
      if (byteRate === null || blockAlign === null || dataBytes !== null || chunkSize === 0) {
        throw new Error('The approved host reference has an invalid audio data chunk.');
      }
      if (chunkSize % blockAlign !== 0) {
        throw new Error('The approved host reference has misaligned audio data.');
      }
      dataBytes = chunkSize;
    }
    offset = paddedEnd;
  }
  if (byteRate === null || dataBytes === null) {
    throw new Error('The approved host reference is missing PCM format or audio data.');
  }
  return Math.round((dataBytes / byteRate) * 1_000);
}

function matchingReferenceIdentity(
  profile: DesktopVoiceProfile,
  approval: DesktopVoiceApproval,
): boolean {
  return (
    profile.voiceId === approval.voiceId &&
    profile.voiceName === approval.voiceName &&
    profile.reference.sha256 === approval.reference.sha256 &&
    profile.reference.transcript === approval.reference.transcript
  );
}

export function persistedDesktopVoiceProfilePath(userDataDirectory: string): string {
  return join(userDataDirectory, 'voice', 'active-profile.json');
}

export function bundledDesktopVoiceProfilePath(
  isPackaged: boolean,
  projectRoot: string,
  resourcesPath: string,
): string {
  return isPackaged
    ? join(resourcesPath, 'host-voice', 'profile.json')
    : join(projectRoot, 'assets', 'voice', 'original-host-v1', 'profile.json');
}

export async function inspectDesktopVoiceProfile(
  profilePath: string,
  label: string,
): Promise<DesktopVoiceProfileInspection> {
  let sourceText: string;
  try {
    sourceText = await readFile(profilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    return {
      found: true,
      error: `The ${label} host profile could not be read: ${errorMessage(error)}`,
    };
  }

  let profileInput: unknown;
  try {
    profileInput = JSON.parse(sourceText) as unknown;
  } catch {
    return { found: true, error: `The ${label} host profile is not valid JSON.` };
  }
  const parsedProfile = DesktopVoiceProfileSchema.safeParse(profileInput);
  if (!parsedProfile.success) {
    return {
      found: true,
      error: `The ${label} host profile is invalid: ${
        parsedProfile.error.issues[0]?.message ?? 'schema validation failed'
      }`,
    };
  }

  const approvalPath = join(dirname(resolve(profilePath)), APPROVAL_FILE_NAME);
  let approvalBytes: Buffer;
  try {
    await verifyRealContainment(profilePath, approvalPath);
    approvalBytes = await readFile(approvalPath);
  } catch (error) {
    return {
      found: true,
      error: `The ${label} host approval could not be verified: ${errorMessage(error)}`,
    };
  }
  let approvalInput: unknown;
  try {
    approvalInput = JSON.parse(approvalBytes.toString('utf8')) as unknown;
  } catch {
    return { found: true, error: `The ${label} host approval is not valid JSON.` };
  }
  const parsedApproval = DesktopVoiceApprovalSchema.safeParse(approvalInput);
  if (!parsedApproval.success) {
    return {
      found: true,
      error: `The ${label} host approval is invalid: ${
        parsedApproval.error.issues[0]?.message ?? 'schema validation failed'
      }`,
    };
  }
  if (!matchingReferenceIdentity(parsedProfile.data, parsedApproval.data)) {
    return {
      found: true,
      error: `The ${label} host profile and approval describe different voice identities.`,
    };
  }
  if (parsedApproval.data.reference.file.includes('/')) {
    return {
      found: true,
      error: `The ${label} host approval reference must be a WAV beside approval.json.`,
    };
  }

  try {
    const referencePath = containedProfileFilePath(
      profilePath,
      parsedProfile.data.reference.file,
      '.wav',
    );
    const approvalReferencePath = containedProfileFilePath(
      approvalPath,
      parsedApproval.data.reference.file,
      '.wav',
    );
    await Promise.all([
      verifyRealContainment(profilePath, referencePath),
      verifyRealContainment(profilePath, approvalReferencePath),
    ]);
    const [referenceBytes, approvalReferenceBytes] = await Promise.all([
      readFile(referencePath),
      readFile(approvalReferencePath),
    ]);
    const durationMs = referenceWaveDurationMs(referenceBytes);
    const approvalDurationMs = referenceWaveDurationMs(approvalReferenceBytes);
    if (
      durationMs < MINIMUM_REFERENCE_DURATION_MS ||
      durationMs > MAXIMUM_REFERENCE_DURATION_MS ||
      approvalDurationMs < MINIMUM_REFERENCE_DURATION_MS ||
      approvalDurationMs > MAXIMUM_REFERENCE_DURATION_MS
    ) {
      return {
        found: true,
        error:
          `The ${label} host reference is outside the approved ` +
          `${MINIMUM_REFERENCE_DURATION_MS}-${MAXIMUM_REFERENCE_DURATION_MS} ms duration.`,
      };
    }
    const referenceSha256 = sha256(referenceBytes);
    const approvalReferenceSha256 = sha256(approvalReferenceBytes);
    if (
      referenceSha256 !== parsedProfile.data.reference.sha256 ||
      approvalReferenceSha256 !== parsedApproval.data.reference.sha256 ||
      referenceSha256 !== approvalReferenceSha256
    ) {
      return {
        found: true,
        error: `The ${label} host reference failed its SHA-256 integrity check.`,
      };
    }

    return {
      found: true,
      verified: {
        profile: parsedProfile.data,
        profilePath: resolve(profilePath),
        approval: parsedApproval.data,
        approvalPath: resolve(approvalPath),
        approvalSha256: sha256(approvalBytes),
        referencePath,
        approvalReferencePath,
        referenceSha256,
      },
    };
  } catch (error) {
    return {
      found: true,
      error: `The ${label} host profile could not be verified: ${errorMessage(error)}`,
    };
  }
}

async function inspectProfileSelection(
  profilePath: string,
  source: Extract<DesktopVoiceProfileSource, 'persisted' | 'bundled' | 'development'>,
  options: ResolveDesktopVoiceOptions,
): Promise<ProfileSelectionInspection> {
  const inspected = await inspectDesktopVoiceProfile(profilePath, source);
  if (!inspected.found) return { found: false };
  if ('error' in inspected) return { found: true, error: inspected.error };
  if (options.isPackaged && source === 'bundled') {
    try {
      await verifyPackagedHostVoiceProfile(
        inspected.verified.profilePath,
        inspected.verified.profile.voiceId,
        inspected.verified.referenceSha256,
      );
    } catch (error) {
      return { found: true, error: errorMessage(error) };
    }
  }

  const runtime = await inspectQwenRuntime(options.userDataDirectory, {
    inheritedEnvironment: options.environment,
    ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
  });
  if (runtime.state !== 'ready') {
    return {
      found: true,
      error:
        `The approved Qwen host is selected, but its local runtime is not ready. ` +
        `${runtime.message} Install or repair the per-user Qwen3-TTS runtime.`,
    };
  }
  if (!(await regularFile(options.qwenWorkerPath))) {
    return {
      found: true,
      error: `The Qwen3-TTS worker is missing: "${options.qwenWorkerPath}".`,
    };
  }
  if (!(await regularFile(options.qwenRuntimeManifestPath))) {
    return {
      found: true,
      error: `The Qwen3-TTS runtime manifest is missing: "${options.qwenRuntimeManifestPath}".`,
    };
  }
  try {
    const runtimeManifestBytes = await readFile(options.qwenRuntimeManifestPath);
    if (sha256(runtimeManifestBytes) !== QWEN_RUNTIME_MANIFEST_SHA256) {
      return {
        found: true,
        error: 'The Qwen3-TTS runtime manifest failed its trusted SHA-256 check.',
      };
    }
  } catch (error) {
    return {
      found: true,
      error: `The Qwen3-TTS runtime manifest could not be verified: ${errorMessage(error)}`,
    };
  }
  if (options.isPackaged) {
    try {
      await Promise.all([
        verifyPackagedVoiceResource(options.qwenWorkerPath),
        verifyPackagedVoiceResource(options.qwenRuntimeManifestPath),
      ]);
    } catch (error) {
      return { found: true, error: errorMessage(error) };
    }
  }

  return {
    found: true,
    selection: {
      kind: 'qwen3-tts',
      source,
      profile: inspected.verified.profile,
      approval: inspected.verified.approval,
      approvalPath: inspected.verified.approvalPath,
      approvalSha256: inspected.verified.approvalSha256,
      referencePath: inspected.verified.approvalReferencePath,
      referenceSha256: inspected.verified.referenceSha256,
      pythonPath: runtime.pythonPath,
      modelCachePath: runtime.receipt.modelCachePath,
      baseModelPath: runtime.baseModelPath,
      asrModelPath: runtime.asrModelPath,
      baseModelRevision: runtime.receipt.models.base.revision,
      asrModelRevision: runtime.receipt.models.asr.revision,
      runtimeManifestPath: resolve(options.qwenRuntimeManifestPath),
      workerPath: resolve(options.qwenWorkerPath),
      device: runtime.receipt.torchBackend === 'cpu' ? 'cpu' : 'cuda',
    },
  };
}

function developmentEngine(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.YAW_VOICE_ENGINE?.trim().toLowerCase();
  return value ? value : null;
}

async function resolveDevelopmentOverride(
  options: ResolveDesktopVoiceOptions,
): Promise<DesktopVoiceSelection | null> {
  const engine = developmentEngine(options.environment);
  if (!engine) return null;

  if (engine === 'system-speech' || engine === 'sapi') {
    if (!(await regularFile(options.systemWorkerPath))) {
      return {
        kind: 'unavailable',
        message: `The explicit System.Speech worker is missing: "${options.systemWorkerPath}".`,
      };
    }
    return {
      kind: 'system-speech',
      source: 'development',
      workerPath: options.systemWorkerPath,
    };
  }

  if (engine !== 'qwen3-tts' && engine !== 'qwen') {
    return {
      kind: 'unavailable',
      message:
        `Unsupported development voice engine "${engine}". ` +
        'Use "qwen3-tts" or explicitly opt into "system-speech".',
    };
  }

  const profileValue = options.environment.YAW_QWEN_PROFILE_PATH?.trim();
  if (!profileValue || !isAbsolute(profileValue)) {
    return {
      kind: 'unavailable',
      message: 'The Qwen development override requires an absolute YAW_QWEN_PROFILE_PATH.',
    };
  }

  const explicitRuntimeValues = {
    pythonPath: options.environment.YAW_QWEN_PYTHON_PATH?.trim(),
    baseModelPath: options.environment.YAW_QWEN_BASE_MODEL_PATH?.trim(),
    asrModelPath: options.environment.YAW_QWEN_ASR_MODEL_PATH?.trim(),
  };
  const explicitRuntimeCount = Object.values(explicitRuntimeValues).filter(Boolean).length;
  if (explicitRuntimeCount > 0 && explicitRuntimeCount !== 3) {
    return {
      kind: 'unavailable',
      message:
        'The Qwen development runtime override must provide Python, Base, and ASR paths together.',
    };
  }
  if (explicitRuntimeCount === 3) {
    const inspectedProfile = await inspectDesktopVoiceProfile(resolve(profileValue), 'development');
    if (!inspectedProfile.found || 'error' in inspectedProfile) {
      return {
        kind: 'unavailable',
        message:
          inspectedProfile.found && 'error' in inspectedProfile
            ? inspectedProfile.error
            : 'The explicit Qwen development profile is missing.',
      };
    }
    const pythonPath = resolve(explicitRuntimeValues.pythonPath!);
    const baseModelPath = resolve(explicitRuntimeValues.baseModelPath!);
    const asrModelPath = resolve(explicitRuntimeValues.asrModelPath!);
    const runtimeManifestPath = resolve(options.qwenRuntimeManifestPath);
    if (
      !(await regularFile(pythonPath)) ||
      !(await regularFile(options.qwenWorkerPath)) ||
      !(await regularFile(runtimeManifestPath)) ||
      !(await directory(baseModelPath)) ||
      !(await directory(asrModelPath)) ||
      !(await pinnedDevelopmentModel(baseModelPath, 'base')) ||
      !(await pinnedDevelopmentModel(asrModelPath, 'asr'))
    ) {
      return {
        kind: 'unavailable',
        message:
          'The explicit Qwen development runtime is missing or does not match the pinned Base and ASR revisions.',
      };
    }
    if (sha256(await readFile(runtimeManifestPath)) !== QWEN_RUNTIME_MANIFEST_SHA256) {
      return {
        kind: 'unavailable',
        message: 'The explicit Qwen development runtime manifest failed its SHA-256 check.',
      };
    }
    const configuredModelCache = options.environment.YAW_QWEN_MODEL_CACHE_PATH?.trim();
    const modelCachePath = configuredModelCache
      ? resolve(configuredModelCache)
      : resolve(dirname(baseModelPath));
    if (
      configuredModelCache &&
      (!isAbsolute(configuredModelCache) || !(await directory(modelCachePath)))
    ) {
      return {
        kind: 'unavailable',
        message: 'YAW_QWEN_MODEL_CACHE_PATH must be an existing absolute directory.',
      };
    }
    return {
      kind: 'qwen3-tts',
      source: 'development',
      profile: inspectedProfile.verified.profile,
      approval: inspectedProfile.verified.approval,
      approvalPath: inspectedProfile.verified.approvalPath,
      approvalSha256: inspectedProfile.verified.approvalSha256,
      referencePath: inspectedProfile.verified.approvalReferencePath,
      referenceSha256: inspectedProfile.verified.referenceSha256,
      pythonPath,
      modelCachePath,
      baseModelPath,
      asrModelPath,
      baseModelRevision: QWEN_RUNTIME_MANIFEST.models.base.revision,
      asrModelRevision: QWEN_RUNTIME_MANIFEST.models.asr.revision,
      runtimeManifestPath,
      workerPath: resolve(options.qwenWorkerPath),
      device: 'cuda',
    };
  }

  const inspected = await inspectProfileSelection(resolve(profileValue), 'development', options);
  return (
    inspected.selection ?? {
      kind: 'unavailable',
      message: inspected.error ?? 'The explicit Qwen development profile is unavailable.',
    }
  );
}

export async function resolveDesktopVoice(
  options: ResolveDesktopVoiceOptions,
): Promise<DesktopVoiceSelection> {
  if (options.allowDevelopmentOverride) {
    const override = await resolveDevelopmentOverride(options);
    if (override) return override;
  }

  const persistedPath =
    options.persistedProfilePath ?? persistedDesktopVoiceProfilePath(options.userDataDirectory);
  const persisted = await inspectProfileSelection(persistedPath, 'persisted', options);
  if (persisted.found) {
    return (
      persisted.selection ?? {
        kind: 'unavailable',
        message: persisted.error ?? 'The persisted Qwen host profile is unavailable.',
      }
    );
  }

  const bundledPath =
    options.bundledProfilePath ??
    bundledDesktopVoiceProfilePath(options.isPackaged, options.projectRoot, options.resourcesPath);
  const bundled = await inspectProfileSelection(bundledPath, 'bundled', options);
  if (bundled.found) {
    return (
      bundled.selection ?? {
        kind: 'unavailable',
        message: bundled.error ?? 'The bundled Qwen host profile is unavailable.',
      }
    );
  }

  return {
    kind: 'unavailable',
    message:
      'No approved Qwen host profile is installed. Approve an original reference and install ' +
      'the local Qwen3-TTS runtime. Start will remain locked.',
  };
}

export function buildRuntimeVoiceEnvironment(
  options: BuildRuntimeVoiceEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...options.inheritedEnvironment };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith('YAW_VOICE_') ||
      normalized.startsWith('YAW_QWEN_') ||
      normalized.startsWith('YAW_CHATTERBOX_') ||
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

  environment.YAW_VOICE_CACHE_PATH = resolve(options.voiceCachePath);
  const selection = options.selection;
  if (selection.kind === 'qwen3-tts') {
    environment.YAW_VOICE_ENGINE = 'qwen3-tts';
    environment.YAW_VOICE_WORKER_PATH = selection.workerPath;
    environment.YAW_QWEN_PYTHON_PATH = selection.pythonPath;
    environment.YAW_QWEN_BASE_MODEL_PATH = selection.baseModelPath;
    environment.YAW_QWEN_ASR_MODEL_PATH = selection.asrModelPath;
    environment.YAW_QWEN_APPROVAL_PATH = selection.approvalPath;
    environment.YAW_QWEN_RUNTIME_MANIFEST_PATH = selection.runtimeManifestPath;
    environment.HF_HOME = join(selection.modelCachePath, 'huggingface');
    environment.HUGGINGFACE_HUB_CACHE = join(environment.HF_HOME, 'hub');
    environment.TORCH_HOME = join(selection.modelCachePath, 'torch');
    environment.HF_HUB_OFFLINE = '1';
    environment.HF_HUB_DISABLE_TELEMETRY = '1';
    environment.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
    environment.TRANSFORMERS_OFFLINE = '1';
    environment.PYTHONNOUSERSITE = '1';
    environment.PYTHONUTF8 = '1';
    environment.PYTHONDONTWRITEBYTECODE = '1';
    environment.CUBLAS_WORKSPACE_CONFIG = ':4096:8';
  } else if (selection.kind === 'system-speech') {
    environment.YAW_VOICE_ENGINE = 'system-speech';
    environment.YAW_VOICE_WORKER_PATH = selection.workerPath;
  } else {
    environment.YAW_VOICE_ENGINE = 'unavailable';
    environment.YAW_VOICE_UNAVAILABLE_MESSAGE = selection.message;
  }
  return environment;
}
