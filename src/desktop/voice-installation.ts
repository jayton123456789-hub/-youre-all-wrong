import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  deterministicQwenEnvironmentPath,
  deterministicQwenModelCachePath,
  inspectQwenRuntime,
  type QwenRuntimeProbe,
} from './qwen-runtime.js';
import {
  inspectDesktopVoiceProfile,
  persistedDesktopVoiceProfilePath,
  type DesktopVoiceProfile,
  type VerifiedDesktopVoiceProfile,
} from './voice-profile.js';

export type QwenTorchBackend = 'auto' | 'cpu' | 'cu128';

export interface QwenInstallerInvocation {
  setupScriptPath: string;
  runtimeManifestPath: string;
  environmentPath: string;
  modelCachePath: string;
  torchBackend: QwenTorchBackend;
}

export interface VoiceInstallationProgress {
  stage: 'validating' | 'installing-runtime' | 'activating-profile' | 'ready';
  message: string;
}

export type QwenInstallerRunner = (
  invocation: QwenInstallerInvocation,
  options: {
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    onOutput?: ((line: string) => void) | undefined;
  },
) => Promise<void>;

export interface DesktopVoiceBootstrapOptions {
  userDataDirectory: string;
  bundledProfilePath: string;
  setupScriptPath: string;
  runtimeManifestPath: string;
  qwenWorkerPath: string;
  torchBackend?: QwenTorchBackend;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runInstaller?: QwenInstallerRunner;
  verifyResource?: (path: string) => Promise<void>;
  verifyBundledProfile?: (profile: VerifiedDesktopVoiceProfile) => Promise<void>;
  runtimeProbe?: QwenRuntimeProbe;
  onProgress?: (progress: VoiceInstallationProgress) => void;
}

export type DesktopVoiceBootstrapState =
  | {
      state: 'ready';
      voiceName: string;
      model: DesktopVoiceProfile['model'];
      environmentPath: string;
      profilePath: string;
      message: string;
    }
  | {
      state: 'installable';
      voiceName: string;
      model: DesktopVoiceProfile['model'];
      environmentPath: string;
      message: string;
    }
  | {
      state: 'repairable';
      voiceName: string;
      model: DesktopVoiceProfile['model'];
      environmentPath: string;
      message: string;
    }
  | {
      state: 'awaiting-profile';
      message: string;
    }
  | {
      state: 'unavailable';
      message: string;
    };

export type DesktopVoiceBootstrapResult =
  | {
      ok: true;
      state: Extract<DesktopVoiceBootstrapState, { state: 'ready' }>;
    }
  | {
      ok: false;
      code:
        | 'profile_missing'
        | 'profile_invalid'
        | 'resource_invalid'
        | 'installer_failed'
        | 'runtime_invalid'
        | 'activation_failed'
        | 'cancelled';
      message: string;
    };

const activeBootstraps = new Map<string, Promise<DesktopVoiceBootstrapResult>>();

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

function publish(
  options: DesktopVoiceBootstrapOptions,
  stage: VoiceInstallationProgress['stage'],
  message: string,
): void {
  options.onProgress?.({ stage, message });
}

export function cleanQwenInstallerEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
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
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONUTF8 = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.POWERSHELL_TELEMETRY_OPTOUT = '1';
  return environment;
}

function absoluteWindowsPowerShell(environment: NodeJS.ProcessEnv): string {
  const windowsRoot = environment.SystemRoot?.trim() || environment.WINDIR?.trim();
  if (!windowsRoot) {
    throw new Error('Windows did not provide SystemRoot for the trusted PowerShell launcher.');
  }
  return join(resolve(windowsRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function terminateWindowsProcessTree(
  processId: number,
  environment: NodeJS.ProcessEnv,
  fallback: () => void,
): void {
  const windowsRoot = environment.SystemRoot?.trim() || environment.WINDIR?.trim();
  if (!windowsRoot) {
    fallback();
    return;
  }
  const taskkillPath = join(resolve(windowsRoot), 'System32', 'taskkill.exe');
  const killer = spawn(taskkillPath, ['/PID', String(processId), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    env: environment,
  });
  killer.once('error', fallback);
  killer.once('close', (code) => {
    if (code !== 0) fallback();
  });
  killer.unref();
}

export const runPowerShellQwenInstaller: QwenInstallerRunner = async (invocation, options) => {
  const executablePath = absoluteWindowsPowerShell(options.environment);
  if (!(await regularFile(executablePath))) {
    throw new Error(`The trusted Windows PowerShell executable is missing: "${executablePath}".`);
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      executablePath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        invocation.setupScriptPath,
        '-EnvironmentPath',
        invocation.environmentPath,
        '-ModelCachePath',
        invocation.modelCachePath,
        '-RuntimeManifestPath',
        invocation.runtimeManifestPath,
        '-TorchBackend',
        invocation.torchBackend,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.environment,
      },
    );
    let settled = false;
    let cancellationRequested = false;
    let cancellationFallback: ReturnType<typeof setTimeout> | null = null;
    let stderr = '';
    let stdoutRemainder = '';

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (cancellationFallback) clearTimeout(cancellationFallback);
      options.signal?.removeEventListener('abort', abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const abort = () => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      if (child.pid) {
        terminateWindowsProcessTree(child.pid, options.environment, () => child.kill());
        cancellationFallback = setTimeout(() => child.kill(), 5_000);
        cancellationFallback.unref();
      } else {
        child.kill();
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/u);
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) options.onOutput?.(line.trim());
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.once('error', (error) =>
      settle(cancellationRequested ? new Error('Qwen3-TTS installation was cancelled.') : error),
    );
    child.once('close', (code) => {
      if (stdoutRemainder.trim()) options.onOutput?.(stdoutRemainder.trim());
      if (cancellationRequested) {
        settle(new Error('Qwen3-TTS installation was cancelled.'));
      } else if (code === 0) {
        settle();
      } else {
        settle(
          new Error(
            `The neural host installer exited with code ${code ?? 'unknown'}.${
              stderr.trim() ? ` ${stderr.trim()}` : ''
            }`,
          ),
        );
      }
    });
  });
};

async function verifyBootstrapResources(options: DesktopVoiceBootstrapOptions): Promise<void> {
  const paths = [options.setupScriptPath, options.runtimeManifestPath, options.qwenWorkerPath];
  for (const path of paths) {
    if (!(await regularFile(path))) {
      throw new Error(`A required packaged neural-host resource is missing: "${path}".`);
    }
    await options.verifyResource?.(path);
  }
}

interface ActivationReplacement {
  targetPath: string;
  bytes: Buffer;
  temporaryPath: string;
  backupPath: string;
  hadOriginal: boolean;
  promoted: boolean;
}

function installedRelativePath(root: string, file: string): string {
  if (isAbsolute(file) || file.includes('\\') || file.includes('\0')) {
    throw new Error('The approved host reference did not remain a safe relative path.');
  }
  const targetPath = resolve(root, ...file.split('/'));
  const fromRoot = relative(resolve(root), targetPath);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('The approved host reference escaped the active voice directory.');
  }
  return targetPath;
}

async function existingRegularFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) {
      throw new Error(`The voice activation target is not a regular file: "${path}".`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stageActivationReplacement(
  targetPath: string,
  bytes: Buffer,
): Promise<ActivationReplacement | null> {
  const hadOriginal = await existingRegularFile(targetPath);
  if (hadOriginal && sha256(await readFile(targetPath)) === sha256(bytes)) {
    return null;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  const transactionId = randomUUID();
  const temporaryPath = `${targetPath}.${transactionId}.tmp`;
  const backupPath = `${targetPath}.${transactionId}.backup`;
  await writeFile(temporaryPath, bytes, { flag: 'wx' });
  if (sha256(await readFile(temporaryPath)) !== sha256(bytes)) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(`A staged voice activation file failed verification: "${targetPath}".`);
  }
  return {
    targetPath,
    bytes,
    temporaryPath,
    backupPath,
    hadOriginal,
    promoted: false,
  };
}

async function restoreActivation(replacements: ActivationReplacement[]): Promise<void> {
  for (const replacement of [...replacements].reverse()) {
    if (replacement.promoted) {
      await unlink(replacement.targetPath).catch(() => undefined);
    }
    if (replacement.hadOriginal) {
      await rename(replacement.backupPath, replacement.targetPath).catch(() => undefined);
    }
    await unlink(replacement.temporaryPath).catch(() => undefined);
  }
}

export async function activateBundledDesktopVoiceProfile(
  userDataDirectory: string,
  verified: VerifiedDesktopVoiceProfile,
): Promise<string> {
  const profilePath = persistedDesktopVoiceProfilePath(userDataDirectory);
  const voiceDirectory = dirname(profilePath);
  const approvalPath = join(voiceDirectory, 'approval.json');
  const profileReferenceRelativePath = `references/${verified.referenceSha256}.wav`;
  const profileReferencePath = installedRelativePath(voiceDirectory, profileReferenceRelativePath);
  const approvalReferencePath = installedRelativePath(
    voiceDirectory,
    verified.approval.reference.file,
  );
  const [profileReferenceBytes, approvalReferenceBytes, approvalBytes] = await Promise.all([
    readFile(verified.referencePath),
    readFile(verified.approvalReferencePath),
    readFile(verified.approvalPath),
  ]);
  if (
    sha256(profileReferenceBytes) !== verified.referenceSha256 ||
    sha256(approvalReferenceBytes) !== verified.referenceSha256
  ) {
    throw new Error('The approved host reference changed during activation.');
  }
  if (sha256(approvalBytes) !== verified.approvalSha256) {
    throw new Error('The approved host record changed during activation.');
  }

  const installedProfile: DesktopVoiceProfile = {
    ...verified.profile,
    reference: {
      ...verified.profile.reference,
      file: profileReferenceRelativePath,
      sha256: verified.referenceSha256,
    },
  };
  const profileBytes = Buffer.from(`${JSON.stringify(installedProfile, null, 2)}\n`, 'utf8');
  const requestedFiles = [
    { targetPath: profileReferencePath, bytes: approvalReferenceBytes },
    { targetPath: approvalReferencePath, bytes: approvalReferenceBytes },
    { targetPath: approvalPath, bytes: approvalBytes },
    { targetPath: profilePath, bytes: profileBytes },
  ];
  const filesByTarget = new Map<string, { targetPath: string; bytes: Buffer }>();
  for (const requested of requestedFiles) {
    const key = resolve(requested.targetPath).toLocaleLowerCase('en-US');
    const existing = filesByTarget.get(key);
    if (existing && !existing.bytes.equals(requested.bytes)) {
      throw new Error(
        `The approved voice bundle maps conflicting files to "${requested.targetPath}".`,
      );
    }
    filesByTarget.set(key, requested);
  }

  await mkdir(voiceDirectory, { recursive: true });
  const replacements: ActivationReplacement[] = [];
  try {
    for (const requested of filesByTarget.values()) {
      const replacement = await stageActivationReplacement(requested.targetPath, requested.bytes);
      if (replacement) replacements.push(replacement);
    }

    for (const replacement of replacements) {
      if (replacement.hadOriginal) {
        await rename(replacement.targetPath, replacement.backupPath);
      }
    }
    for (const replacement of replacements) {
      await rename(replacement.temporaryPath, replacement.targetPath);
      replacement.promoted = true;
    }

    const activated = await inspectDesktopVoiceProfile(profilePath, 'activated');
    if (
      !activated.found ||
      'error' in activated ||
      activated.verified.profile.voiceId !== verified.profile.voiceId ||
      activated.verified.profile.voiceName !== verified.profile.voiceName ||
      activated.verified.profile.engine !== verified.profile.engine ||
      activated.verified.profile.model !== verified.profile.model ||
      activated.verified.profile.reference.file !== profileReferenceRelativePath ||
      activated.verified.profile.reference.transcript !== verified.profile.reference.transcript ||
      activated.verified.referenceSha256 !== verified.referenceSha256 ||
      activated.verified.approvalSha256 !== verified.approvalSha256
    ) {
      const detail = activated.found && 'error' in activated ? ` ${activated.error}` : '';
      throw new Error(`The activated host profile failed its final verification.${detail}`);
    }
    await Promise.all(
      replacements
        .filter((replacement) => replacement.hadOriginal)
        .map((replacement) => unlink(replacement.backupPath).catch(() => undefined)),
    );
    return profilePath;
  } catch (error) {
    await restoreActivation(replacements);
    throw error;
  } finally {
    await Promise.all(
      replacements.flatMap((replacement) => [
        unlink(replacement.temporaryPath).catch(() => undefined),
        unlink(replacement.backupPath).catch(() => undefined),
      ]),
    );
  }
}

export async function inspectDesktopVoiceBootstrap(
  options: DesktopVoiceBootstrapOptions,
): Promise<DesktopVoiceBootstrapState> {
  const inspectedProfile = await inspectDesktopVoiceProfile(options.bundledProfilePath, 'bundled');
  if (!inspectedProfile.found) {
    return {
      state: 'awaiting-profile',
      message:
        'The approved original-host profile has not been bundled yet. No substitute voice will be installed.',
    };
  }
  if ('error' in inspectedProfile) {
    return {
      state: 'unavailable',
      message: inspectedProfile.error,
    };
  }
  try {
    await options.verifyBundledProfile?.(inspectedProfile.verified);
  } catch (error) {
    return {
      state: 'unavailable',
      message: errorMessage(error),
    };
  }

  try {
    await verifyBootstrapResources(options);
  } catch (error) {
    return {
      state: 'unavailable',
      message: errorMessage(error),
    };
  }

  const runtime = await inspectQwenRuntime(options.userDataDirectory, {
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
  });
  const persistedProfilePath = persistedDesktopVoiceProfilePath(options.userDataDirectory);
  const persistedProfile = await inspectDesktopVoiceProfile(persistedProfilePath, 'persisted');
  const profileActivated =
    persistedProfile.found &&
    !('error' in persistedProfile) &&
    persistedProfile.verified.profile.voiceId === inspectedProfile.verified.profile.voiceId &&
    persistedProfile.verified.profile.voiceName === inspectedProfile.verified.profile.voiceName &&
    persistedProfile.verified.profile.model === inspectedProfile.verified.profile.model &&
    persistedProfile.verified.profile.engine === inspectedProfile.verified.profile.engine &&
    persistedProfile.verified.profile.reference.transcript ===
      inspectedProfile.verified.profile.reference.transcript &&
    persistedProfile.verified.referenceSha256 === inspectedProfile.verified.referenceSha256 &&
    persistedProfile.verified.approvalSha256 === inspectedProfile.verified.approvalSha256;
  const shared = {
    voiceName: inspectedProfile.verified.profile.voiceName,
    model: inspectedProfile.verified.profile.model,
    environmentPath: deterministicQwenEnvironmentPath(options.userDataDirectory),
  };
  if (runtime.state === 'ready' && profileActivated) {
    return {
      state: 'ready',
      ...shared,
      profilePath: persistedProfilePath,
      message: `${shared.voiceName} and its local neural runtime are verified.`,
    };
  }
  return {
    state:
      runtime.state === 'missing' || (runtime.state === 'ready' && !persistedProfile.found)
        ? 'installable'
        : 'repairable',
    ...shared,
    message:
      runtime.state === 'ready'
        ? 'The local Qwen3-TTS runtime is verified; the approved host profile still needs activation.'
        : runtime.message,
  };
}

async function bootstrapOnce(
  options: DesktopVoiceBootstrapOptions,
): Promise<DesktopVoiceBootstrapResult> {
  publish(options, 'validating', 'Validating the approved host and packaged installer…');
  const inspectedProfile = await inspectDesktopVoiceProfile(options.bundledProfilePath, 'bundled');
  if (!inspectedProfile.found) {
    return {
      ok: false,
      code: 'profile_missing',
      message:
        'The approved original-host profile has not been bundled yet. Installation did not run.',
    };
  }
  if ('error' in inspectedProfile) {
    return { ok: false, code: 'profile_invalid', message: inspectedProfile.error };
  }
  try {
    await options.verifyBundledProfile?.(inspectedProfile.verified);
  } catch (error) {
    return { ok: false, code: 'profile_invalid', message: errorMessage(error) };
  }

  try {
    await verifyBootstrapResources(options);
  } catch (error) {
    return { ok: false, code: 'resource_invalid', message: errorMessage(error) };
  }

  const environmentPath = deterministicQwenEnvironmentPath(options.userDataDirectory);
  const modelCachePath = deterministicQwenModelCachePath(options.userDataDirectory);
  let runtime = await inspectQwenRuntime(options.userDataDirectory, {
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
  });
  if (runtime.state !== 'ready') {
    publish(
      options,
      'installing-runtime',
      `Installing and validating the ${inspectedProfile.verified.profile.model} Qwen3-TTS runtime…`,
    );
    const runInstaller = options.runInstaller ?? runPowerShellQwenInstaller;
    try {
      await runInstaller(
        {
          setupScriptPath: resolve(options.setupScriptPath),
          runtimeManifestPath: resolve(options.runtimeManifestPath),
          environmentPath,
          modelCachePath,
          torchBackend: options.torchBackend ?? 'auto',
        },
        {
          environment: cleanQwenInstallerEnvironment(options.inheritedEnvironment ?? process.env),
          signal: options.signal,
          onOutput: (message) => publish(options, 'installing-runtime', message),
        },
      );
    } catch (error) {
      const cancelled = options.signal?.aborted === true;
      return {
        ok: false,
        code: cancelled ? 'cancelled' : 'installer_failed',
        message: errorMessage(error),
      };
    }

    runtime = await inspectQwenRuntime(options.userDataDirectory, {
      inheritedEnvironment: options.inheritedEnvironment ?? process.env,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
    });
    if (runtime.state !== 'ready') {
      return {
        ok: false,
        code: 'runtime_invalid',
        message: runtime.message,
      };
    }
  }

  publish(options, 'activating-profile', 'Activating the verified original host…');
  let profilePath: string;
  try {
    profilePath = await activateBundledDesktopVoiceProfile(
      options.userDataDirectory,
      inspectedProfile.verified,
    );
  } catch (error) {
    return { ok: false, code: 'activation_failed', message: errorMessage(error) };
  }

  const state: Extract<DesktopVoiceBootstrapState, { state: 'ready' }> = {
    state: 'ready',
    voiceName: inspectedProfile.verified.profile.voiceName,
    model: inspectedProfile.verified.profile.model,
    environmentPath,
    profilePath,
    message: `${inspectedProfile.verified.profile.voiceName} is installed and ready to cook episodes.`,
  };
  publish(options, 'ready', state.message);
  return { ok: true, state };
}

export function bootstrapDesktopVoice(
  options: DesktopVoiceBootstrapOptions,
): Promise<DesktopVoiceBootstrapResult> {
  const key = resolve(options.userDataDirectory).toLocaleLowerCase('en-US');
  const active = activeBootstraps.get(key);
  if (active) return active;
  const bootstrap = bootstrapOnce(options).finally(() => {
    if (activeBootstraps.get(key) === bootstrap) activeBootstraps.delete(key);
  });
  activeBootstraps.set(key, bootstrap);
  return bootstrap;
}
