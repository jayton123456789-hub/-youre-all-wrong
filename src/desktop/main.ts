import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from 'electron';

import { buildEpisodeAuthorKitArchive, EPISODE_AUTHOR_KIT_FILENAME } from './episode-author-kit.js';
import type { DesktopAuthorKitResult, DesktopEpisodeActionResult } from './episode-contract.js';
import { migrateVerifiedLegacyVoiceCache } from './legacy-voice-cache.js';
import { runQwenRuntimeProbe } from './qwen-runtime.js';
import {
  clearActiveEpisode,
  formatValidationIssues,
  importEpisodeFile,
  loadActiveEpisode,
  persistActiveEpisode,
  summarizeEpisode,
  type LoadedEpisode,
} from './episode-library.js';
import {
  buildRuntimeVoiceEnvironment,
  bundledDesktopVoiceProfilePath,
  resolveDesktopVoice,
  type DesktopVoiceSelection,
  type ResolveDesktopVoiceOptions,
} from './voice-profile.js';
import {
  bootstrapDesktopVoice,
  inspectDesktopVoiceBootstrap,
  type DesktopVoiceBootstrapOptions,
  type DesktopVoiceBootstrapResult,
} from './voice-installation.js';
import {
  verifyPackagedHostVoiceProfile,
  verifyPackagedVoiceResource,
} from './packaged-voice-resources.js';

interface RuntimeReadyMessage {
  type: 'runtime-ready';
  started: {
    hostUrl: string;
    joinUrls: string[];
    port: number;
  };
}

interface RuntimeErrorMessage {
  type: 'runtime-error';
  category: 'episode' | 'voice' | 'runtime';
  message: string;
}

type RuntimeMessage = RuntimeReadyMessage | RuntimeErrorMessage;

let mainWindow: BrowserWindow | null = null;
let runtimeProcess: UtilityProcess | null = null;
let quitting = false;
let restartAttempts = 0;
let pendingEpisodeRestart = false;
let restartKillTimer: ReturnType<typeof setTimeout> | null = null;
let activeEpisode: LoadedEpisode | null = null;
let activeVoice: DesktopVoiceSelection | null = null;
let pendingRuntimeRecovery: Promise<void> | null = null;
let voiceInstallationAbortController: AbortController | null = null;
let voiceInstallationPromise: Promise<DesktopVoiceBootstrapResult> | null = null;
let interactiveVoiceSetupOpen = false;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function createRuntimeIdentity() {
  return {
    sessionId: randomUUID(),
    code: Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join(''),
    hostSecret: randomBytes(32).toString('base64url'),
    joinSecret: randomBytes(18).toString('base64url'),
  };
}

let runtimeIdentity = createRuntimeIdentity();
const installHostVoiceRequested = process.argv.includes('--install-host-voice');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

function desktopProjectRoot(): string {
  return app.isPackaged ? app.getAppPath() : resolve(__dirname, '..', '..');
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#09070f',
    autoHideMenuBar: true,
    title: "YOU'RE ALL WRONG!",
    icon: join(desktopProjectRoot(), 'assets', 'branding', 'app-icon-master.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      if (
        target.hostname !== '127.0.0.1' &&
        target.hostname !== 'localhost' &&
        !target.hostname.startsWith('192.168.') &&
        !target.hostname.startsWith('10.') &&
        !/^172\.(1[6-9]|2\d|3[01])\./.test(target.hostname)
      ) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });
  return window;
}

async function restoreDemoAfterRuntimeFailure(
  window: BrowserWindow,
  failedEpisodeTitle: string,
  runtimeMessage: string,
): Promise<void> {
  await clearActiveEpisode(app.getPath('userData'));
  activeEpisode = await loadActiveEpisode(app.getPath('userData'));
  const warning = `"${failedEpisodeTitle}" could not start, so the bundled demo was restored. ${runtimeMessage}`;
  activeEpisode.state.warning = warning;
  runtimeIdentity = createRuntimeIdentity();
  restartAttempts = 0;

  if (!window.isDestroyed()) {
    window.webContents.send('episode:runtime-failed', activeEpisode.state);
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Custom episode could not start',
      message: 'The custom episode failed safely. The bundled demo is being restored.',
      detail: runtimeMessage,
    });
  }
}

function startRuntime(window: BrowserWindow): void {
  if (!activeEpisode) {
    throw new Error('Cannot start the show runtime before an episode has been selected.');
  }
  if (!activeVoice) {
    throw new Error('Cannot start the show runtime before the host voice has been resolved.');
  }
  const runtimeEntry = join(__dirname, 'runtime-process.cjs');
  const isDevelopment = Boolean(process.env.YAW_DEV_WEB_URL);
  const webRoot = join(desktopProjectRoot(), 'dist', 'web');
  const runtimeVoiceEnvironment = buildRuntimeVoiceEnvironment({
    inheritedEnvironment: process.env,
    selection: activeVoice,
    voiceCachePath: join(app.getPath('userData'), 'voice-cache'),
  });

  runtimeProcess = utilityProcess.fork(runtimeEntry, [], {
    serviceName: "YOU'RE ALL WRONG! Runtime",
    stdio: 'pipe',
    env: {
      ...runtimeVoiceEnvironment,
      YAW_PORT: '0',
      YAW_DATABASE_PATH: join(app.getPath('userData'), 'runtime.sqlite'),
      YAW_SESSION_ID: runtimeIdentity.sessionId,
      YAW_SESSION_CODE: runtimeIdentity.code,
      YAW_HOST_SECRET: runtimeIdentity.hostSecret,
      YAW_JOIN_SECRET: runtimeIdentity.joinSecret,
      YAW_SHOWPACK_PATH: activeEpisode.packPath ?? '',
      YAW_SHOWPACK_ASSET_ROOT: activeEpisode.assetRoot ?? '',
      YAW_SHOWPACK_ARCHIVE_PATH: activeEpisode.archivePath ?? '',
      ...(isDevelopment
        ? { YAW_PUBLIC_WEB_PORT: new URL(process.env.YAW_DEV_WEB_URL!).port || '5173' }
        : { YAW_WEB_ROOT: webRoot }),
    },
  });

  runtimeProcess.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[runtime] ${chunk.toString()}`);
  });
  runtimeProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[runtime] ${chunk.toString()}`);
  });

  runtimeProcess.on('message', (message: RuntimeMessage) => {
    if (message.type === 'runtime-error') {
      if (message.category === 'episode' && activeEpisode?.state.episode.source === 'custom') {
        pendingRuntimeRecovery ??= restoreDemoAfterRuntimeFailure(
          window,
          activeEpisode.state.episode.title,
          message.message,
        );
        return;
      }
      if (message.category === 'voice' && activeEpisode) {
        activeEpisode.state.warning = `The episode is intact, but its local host voice could not start. ${message.message}`;
        if (!window.isDestroyed()) {
          window.webContents.send('episode:runtime-failed', activeEpisode.state);
        }
      }
      void dialog.showMessageBox(window, {
        type: 'error',
        title:
          message.category === 'voice' ? 'Host voice failed to start' : 'Runtime failed to start',
        message:
          message.category === 'voice'
            ? 'The episode was preserved, but the local neural host needs attention.'
            : "YOU'RE ALL WRONG! could not start its local game server.",
        detail: message.message,
      });
      return;
    }

    restartAttempts = 0;
    const target = isDevelopment
      ? `${process.env.YAW_DEV_WEB_URL}/host${new URL(message.started.hostUrl).hash}`
      : message.started.hostUrl;
    void window.loadURL(target);
  });

  runtimeProcess.on('exit', (code) => {
    runtimeProcess = null;
    if (restartKillTimer) {
      clearTimeout(restartKillTimer);
      restartKillTimer = null;
    }
    if (!quitting) {
      if (pendingRuntimeRecovery) {
        const recovery = pendingRuntimeRecovery;
        pendingRuntimeRecovery = null;
        void recovery
          .then(() => {
            if (!quitting && !runtimeProcess && !window.isDestroyed()) startRuntime(window);
          })
          .catch((error: unknown) => {
            void dialog.showMessageBox(window, {
              type: 'error',
              title: 'Episode recovery failed',
              message: 'The custom episode failed and the bundled demo could not be restored.',
              detail: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      if (pendingEpisodeRestart) {
        pendingEpisodeRestart = false;
        restartAttempts = 0;
        if (!window.isDestroyed()) startRuntime(window);
        return;
      }
      restartAttempts += 1;
      if (restartAttempts <= 3) {
        setTimeout(() => {
          if (!quitting && !runtimeProcess && !window.isDestroyed()) startRuntime(window);
        }, 750 * restartAttempts);
      } else {
        void dialog.showMessageBox(window, {
          type: 'error',
          title: 'The show runtime stopped',
          message: 'The game server could not recover after three attempts.',
          detail: `Last exit code: ${code}`,
        });
      }
    }
  });
}

function restartRuntimeForEpisode(window: BrowserWindow): void {
  runtimeIdentity = createRuntimeIdentity();
  restartAttempts = 0;
  pendingEpisodeRestart = true;

  if (!runtimeProcess) {
    pendingEpisodeRestart = false;
    startRuntime(window);
    return;
  }

  const processToStop = runtimeProcess;
  try {
    processToStop.postMessage({ type: 'shutdown' });
  } catch {
    processToStop.kill();
  }
  restartKillTimer = setTimeout(() => {
    if (runtimeProcess === processToStop) processToStop.kill();
  }, 5_000);
}

function invokingWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window && window === mainWindow && !window.isDestroyed() ? window : null;
}

function episodeFailure(message: string): DesktopEpisodeActionResult {
  return { ok: false, cancelled: false, message };
}

interface DesktopVoicePaths {
  projectRoot: string;
  resourcesRoot: string;
  userDataDirectory: string;
  qwenWorkerPath: string;
  systemWorkerPath: string;
  setupScriptPath: string;
  runtimeManifestPath: string;
  bundledProfilePath: string;
}

function desktopVoicePaths(): DesktopVoicePaths {
  const projectRoot = desktopProjectRoot();
  const resourcesRoot = process.resourcesPath;
  const servicesRoot = app.isPackaged ? resourcesRoot : join(projectRoot, 'services');
  return {
    projectRoot,
    resourcesRoot,
    userDataDirectory: app.getPath('userData'),
    qwenWorkerPath: join(servicesRoot, 'qwen-voice-worker.py'),
    systemWorkerPath: join(servicesRoot, 'system-voice-worker.ps1'),
    setupScriptPath: join(servicesRoot, 'setup-qwen-tts.ps1'),
    runtimeManifestPath: join(servicesRoot, 'qwen-runtime-manifest.json'),
    bundledProfilePath: bundledDesktopVoiceProfilePath(app.isPackaged, projectRoot, resourcesRoot),
  };
}

function desktopVoiceResolveOptions(): ResolveDesktopVoiceOptions {
  const paths = desktopVoicePaths();
  return {
    environment: process.env,
    allowDevelopmentOverride: !app.isPackaged,
    isPackaged: app.isPackaged,
    projectRoot: paths.projectRoot,
    resourcesPath: paths.resourcesRoot,
    userDataDirectory: paths.userDataDirectory,
    qwenWorkerPath: paths.qwenWorkerPath,
    qwenRuntimeManifestPath: paths.runtimeManifestPath,
    systemWorkerPath: paths.systemWorkerPath,
    ...(app.isPackaged ? { runtimeProbe: runQwenRuntimeProbe } : {}),
  };
}

function desktopVoiceBootstrapOptions(
  window: BrowserWindow,
  signal?: AbortSignal,
): DesktopVoiceBootstrapOptions {
  const paths = desktopVoicePaths();
  return {
    userDataDirectory: paths.userDataDirectory,
    bundledProfilePath: paths.bundledProfilePath,
    setupScriptPath: paths.setupScriptPath,
    runtimeManifestPath: paths.runtimeManifestPath,
    qwenWorkerPath: paths.qwenWorkerPath,
    inheritedEnvironment: process.env,
    ...(app.isPackaged ? { runtimeProbe: runQwenRuntimeProbe } : {}),
    ...(signal ? { signal } : {}),
    ...(app.isPackaged
      ? {
          verifyResource: (path: string) => verifyPackagedVoiceResource(path),
          verifyBundledProfile: (profile) =>
            verifyPackagedHostVoiceProfile(
              profile.profilePath,
              profile.profile.voiceId,
              profile.referenceSha256,
            ),
        }
      : {}),
    onProgress: (progress) => {
      if (!window.isDestroyed()) {
        window.webContents.send('voice:installation-progress', progress);
        window.setTitle(`Installing neural host — ${progress.message}`);
      }
    },
  };
}

function performVoiceInstallation(window: BrowserWindow): Promise<DesktopVoiceBootstrapResult> {
  if (voiceInstallationPromise) return voiceInstallationPromise;
  const controller = new AbortController();
  voiceInstallationAbortController = controller;
  window.setProgressBar(2, { mode: 'indeterminate' });
  voiceInstallationPromise = (async () => {
    try {
      const result = await bootstrapDesktopVoice(
        desktopVoiceBootstrapOptions(window, controller.signal),
      );
      if (!result.ok) return result;

      const selected = await resolveDesktopVoice(desktopVoiceResolveOptions());
      if (selected.kind !== 'qwen3-tts') {
        return {
          ok: false,
          code: 'activation_failed',
          message:
            selected.kind === 'unavailable'
              ? selected.message
              : 'The installer completed, but the approved neural host was not selected.',
        };
      }
      activeVoice = selected;
      if (!quitting && !window.isDestroyed()) restartRuntimeForEpisode(window);
      return result;
    } finally {
      if (voiceInstallationAbortController === controller) {
        voiceInstallationAbortController = null;
      }
      voiceInstallationPromise = null;
      if (!window.isDestroyed()) {
        window.setProgressBar(-1);
        window.setTitle("YOU'RE ALL WRONG!");
      }
    }
  })();
  return voiceInstallationPromise;
}

function registerVoiceIpc(): void {
  ipcMain.handle('voice:get-installation-state', async (event) => {
    const window = invokingWindow(event);
    if (!window) {
      return {
        state: 'unavailable' as const,
        message: 'Neural-host setup was denied for this window.',
      };
    }
    return inspectDesktopVoiceBootstrap(desktopVoiceBootstrapOptions(window));
  });

  ipcMain.handle('voice:install', async (event): Promise<DesktopVoiceBootstrapResult> => {
    const window = invokingWindow(event);
    if (!window) {
      return {
        ok: false,
        code: 'resource_invalid',
        message: 'Neural-host setup was denied for this window.',
      };
    }
    return performVoiceInstallation(window);
  });
}

async function openInteractiveVoiceSetup(window: BrowserWindow): Promise<void> {
  if (interactiveVoiceSetupOpen || window.isDestroyed()) return;
  interactiveVoiceSetupOpen = true;
  try {
    const state = await inspectDesktopVoiceBootstrap(desktopVoiceBootstrapOptions(window));
    if (state.state === 'awaiting-profile' || state.state === 'unavailable') {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Neural host is not installable',
        message: 'This build cannot install its original host.',
        detail: state.message,
      });
      return;
    }
    if (state.state === 'ready') {
      await dialog.showMessageBox(window, {
        type: 'info',
        title: 'Neural host is ready',
        message: `${state.voiceName} is already installed and verified.`,
        detail: `Runtime: ${state.environmentPath}`,
      });
      return;
    }

    const confirmation = await dialog.showMessageBox(window, {
      type: 'question',
      title: state.state === 'repairable' ? 'Repair neural host?' : 'Install neural host?',
      message:
        state.state === 'repairable'
          ? `Repair ${state.voiceName} and its local ${state.model} runtime?`
          : `Install ${state.voiceName} and its local ${state.model} runtime?`,
      detail:
        'This downloads several gigabytes into your private Windows profile, may take several minutes, and generates no audio during setup. Start remains locked until verification succeeds.',
      buttons: [state.state === 'repairable' ? 'Repair' : 'Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return;

    const result = await performVoiceInstallation(window);
    await dialog.showMessageBox(window, {
      type: result.ok ? 'info' : 'error',
      title: result.ok ? 'Neural host ready' : 'Neural host setup failed',
      message: result.ok
        ? `${result.state.voiceName} is installed and ready to cook episodes.`
        : result.message,
      detail: result.ok
        ? 'The local show runtime is restarting with the verified original host.'
        : 'The episode was preserved. Start remains locked until the voice setup is repaired.',
    });
  } finally {
    interactiveVoiceSetupOpen = false;
  }
}

function registerEpisodeIpc(): void {
  ipcMain.handle('episode:get-active', (event) => {
    if (!invokingWindow(event) || !activeEpisode) {
      return {
        episode: {
          id: 'unavailable',
          title: 'Episode unavailable',
          author: 'Runtime',
          source: 'demo' as const,
        },
        warning: 'The desktop episode library is not ready.',
      };
    }
    return activeEpisode.state;
  });

  ipcMain.handle('episode:choose', async (event): Promise<DesktopEpisodeActionResult> => {
    const window = invokingWindow(event);
    if (!window) return episodeFailure('Episode selection was denied for this window.');

    const selection = await dialog.showOpenDialog(window, {
      title: 'Load a custom YOU’RE ALL WRONG! episode',
      buttonLabel: 'Load this episode',
      properties: ['openFile'],
      filters: [
        { name: 'YOU’RE ALL WRONG! episodes', extensions: ['showpack', 'json'] },
        { name: 'Showpack archives', extensions: ['showpack'] },
        { name: 'Episode JSON', extensions: ['json'] },
      ],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) {
      return { ok: false, cancelled: true, message: '' };
    }

    const imported = await importEpisodeFile(selectedPath);
    if (!imported.ok) {
      return episodeFailure(formatValidationIssues(imported.issues));
    }

    try {
      const persisted = await persistActiveEpisode(
        app.getPath('userData'),
        imported.pack,
        imported.archive,
      );
      const episode = summarizeEpisode(imported.pack, 'custom');
      activeEpisode = {
        pack: imported.pack,
        packHash: imported.packHash,
        ...persisted,
        state: { episode, warning: null },
      };
      setTimeout(() => {
        if (!quitting && !window.isDestroyed()) restartRuntimeForEpisode(window);
      }, 80);
      return { ok: true, episode, restarting: true };
    } catch (error) {
      return episodeFailure(
        `The episode passed validation but could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  ipcMain.handle('episode:use-demo', async (event): Promise<DesktopEpisodeActionResult> => {
    const window = invokingWindow(event);
    if (!window) return episodeFailure('Episode selection was denied for this window.');
    if (activeEpisode?.state.episode.source === 'demo' && !activeEpisode.state.warning) {
      return {
        ok: true,
        episode: activeEpisode.state.episode,
        restarting: false,
      };
    }

    try {
      await clearActiveEpisode(app.getPath('userData'));
      activeEpisode = await loadActiveEpisode(app.getPath('userData'));
      const episode = activeEpisode.state.episode;
      setTimeout(() => {
        if (!quitting && !window.isDestroyed()) restartRuntimeForEpisode(window);
      }, 80);
      return { ok: true, episode, restarting: true };
    } catch (error) {
      return episodeFailure(
        `The bundled demo could not be restored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  ipcMain.handle('episode:download-author-kit', async (event): Promise<DesktopAuthorKitResult> => {
    const window = invokingWindow(event);
    if (!window) {
      return {
        ok: false,
        cancelled: false,
        message: 'The author kit download was denied for this window.',
      };
    }

    const selection = await dialog.showSaveDialog(window, {
      title: 'Save the YOU’RE ALL WRONG! AI episode author kit',
      buttonLabel: 'Save author kit',
      defaultPath: join(app.getPath('downloads'), EPISODE_AUTHOR_KIT_FILENAME),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { ok: false, cancelled: true, message: '' };
    }

    try {
      const archive = buildEpisodeAuthorKitArchive();
      await writeFile(selection.filePath, archive);
      return { ok: true, filePath: selection.filePath };
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        message: `The author kit could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
}

app.on('second-instance', (_event, commandLine) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  if (commandLine.includes('--install-host-voice')) {
    void openInteractiveVoiceSetup(mainWindow);
  }
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userDataDirectory = app.getPath('userData');
  const legacyVoiceCache = join(app.getPath('appData'), 'Electron', 'voice-cache');
  const migratedCache = await migrateVerifiedLegacyVoiceCache(
    legacyVoiceCache,
    join(userDataDirectory, 'voice-cache'),
  ).catch(() => null);
  if (migratedCache?.imported) {
    console.log(`Imported ${migratedCache.imported} verified legacy voice-cache entries.`);
  }

  activeEpisode = await loadActiveEpisode(userDataDirectory);
  activeVoice = await resolveDesktopVoice(desktopVoiceResolveOptions());
  registerEpisodeIpc();
  registerVoiceIpc();
  mainWindow = createWindow();
  startRuntime(mainWindow);
  if (installHostVoiceRequested) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) void openInteractiveVoiceSetup(mainWindow);
    }, 500);
  }
});

app.on('before-quit', () => {
  quitting = true;
  voiceInstallationAbortController?.abort();
  runtimeProcess?.postMessage({ type: 'shutdown' });
});

app.on('window-all-closed', () => {
  app.quit();
});
