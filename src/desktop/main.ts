import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, session, utilityProcess, type UtilityProcess } from 'electron';

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
  message: string;
}

type RuntimeMessage = RuntimeReadyMessage | RuntimeErrorMessage;

let mainWindow: BrowserWindow | null = null;
let runtimeProcess: UtilityProcess | null = null;
let quitting = false;
let restartAttempts = 0;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const runtimeIdentity = {
  sessionId: randomUUID(),
  code: Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join(''),
  hostSecret: randomBytes(32).toString('base64url'),
  joinSecret: randomBytes(18).toString('base64url'),
};

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
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
    icon: join(app.getAppPath(), 'assets', 'branding', 'app-icon-master.png'),
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

function startRuntime(window: BrowserWindow): void {
  const runtimeEntry = join(__dirname, 'runtime-process.cjs');
  const isDevelopment = Boolean(process.env.YAW_DEV_WEB_URL);
  const webRoot = join(app.getAppPath(), 'dist', 'web');
  const voiceWorkerPath = app.isPackaged
    ? join(process.resourcesPath, 'system-voice-worker.ps1')
    : join(app.getAppPath(), 'services', 'system-voice-worker.ps1');

  runtimeProcess = utilityProcess.fork(runtimeEntry, [], {
    serviceName: "YOU'RE ALL WRONG! Runtime",
    stdio: 'pipe',
    env: {
      ...process.env,
      YAW_PORT: '0',
      YAW_DATABASE_PATH: join(app.getPath('userData'), 'runtime.sqlite'),
      YAW_SESSION_ID: runtimeIdentity.sessionId,
      YAW_SESSION_CODE: runtimeIdentity.code,
      YAW_HOST_SECRET: runtimeIdentity.hostSecret,
      YAW_JOIN_SECRET: runtimeIdentity.joinSecret,
      YAW_VOICE_CACHE_PATH: join(app.getPath('userData'), 'voice-cache'),
      YAW_VOICE_WORKER_PATH: voiceWorkerPath,
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
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Runtime failed to start',
        message: "YOU'RE ALL WRONG! could not start its local game server.",
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
    if (!quitting) {
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

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  mainWindow = createWindow();
  startRuntime(mainWindow);
});

app.on('before-quit', () => {
  quitting = true;
  runtimeProcess?.postMessage({ type: 'shutdown' });
});

app.on('window-all-closed', () => {
  app.quit();
});
