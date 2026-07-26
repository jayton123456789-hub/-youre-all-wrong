import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import type { Showpack } from '../domain/showpack/schema.js';
import { validateShowpack } from '../domain/showpack/validate.js';
import { createGameServer } from '../server/app.js';
import { createQwenVoiceAdapterFromEnvironment } from '../server/qwen-renderer.js';
import { loadShowpackAssetLibrary } from '../server/showpack-assets.js';
import {
  EpisodeVoicePreflight,
  UnavailableVoicePreflight,
  type VoicePreflightService,
} from '../server/voice-preflight.js';

interface ParentMessage {
  type: 'shutdown';
}

type RuntimeFailureCategory = 'episode' | 'voice' | 'runtime';
let startupFailureCategory: RuntimeFailureCategory = 'episode';

function requiredVoicePath(name: 'YAW_VOICE_CACHE_PATH' | 'YAW_VOICE_WORKER_PATH'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The selected local voice is missing its required ${name} setting.`);
  }
  return resolve(value);
}

async function configuredVoicePreflight(pack: Showpack): Promise<VoicePreflightService> {
  const engine = process.env.YAW_VOICE_ENGINE?.trim().toLowerCase();
  if (engine === 'qwen3-tts' || engine === 'qwen') {
    const adapter = await createQwenVoiceAdapterFromEnvironment(process.env);
    return new EpisodeVoicePreflight({
      pack,
      cacheDirectory: requiredVoicePath('YAW_VOICE_CACHE_PATH'),
      workerPath: adapter.workerPath,
      renderer: adapter.renderer,
      runWorker: adapter.runWorker,
    });
  }

  if (engine === 'system-speech' || engine === 'sapi') {
    return new EpisodeVoicePreflight({
      pack,
      cacheDirectory: requiredVoicePath('YAW_VOICE_CACHE_PATH'),
      workerPath: requiredVoicePath('YAW_VOICE_WORKER_PATH'),
    });
  }

  const message =
    process.env.YAW_VOICE_UNAVAILABLE_MESSAGE?.trim() ||
    (engine && engine !== 'unavailable'
      ? `Unsupported local voice engine "${engine}". Start is locked until an approved neural host is configured.`
      : 'No approved neural host profile is installed. Start is locked until the local Qwen host is configured.');
  return new UnavailableVoicePreflight(message);
}

async function loadConfiguredEpisode(): Promise<unknown> {
  const configuredPath = process.env.YAW_SHOWPACK_PATH;
  if (!configuredPath) return demoPack;

  try {
    const source = await readFile(resolve(configuredPath), 'utf8');
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `The active episode document could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function run(): Promise<void> {
  const validation = validateShowpack(await loadConfiguredEpisode());
  if (!validation.ok) {
    throw new Error(`The active episode is invalid: ${JSON.stringify(validation.issues)}`);
  }
  const showpackAssets = await loadShowpackAssetLibrary(
    validation.pack,
    process.env.YAW_SHOWPACK_ASSET_ROOT || undefined,
  );

  startupFailureCategory = 'voice';
  const voice = await configuredVoicePreflight(validation.pack);
  startupFailureCategory = 'runtime';
  const server = await createGameServer({
    pack: validation.pack,
    packHash: validation.packHash,
    host: '0.0.0.0',
    port: Number(process.env.YAW_PORT ?? 0),
    ...(process.env.YAW_PUBLIC_WEB_PORT
      ? { publicWebPort: Number(process.env.YAW_PUBLIC_WEB_PORT) }
      : {}),
    ...(process.env.YAW_WEB_ROOT ? { webRoot: resolve(process.env.YAW_WEB_ROOT) } : {}),
    ...(process.env.YAW_DATABASE_PATH
      ? { databasePath: resolve(process.env.YAW_DATABASE_PATH) }
      : {}),
    ...(process.env.YAW_SESSION_ID ? { sessionId: process.env.YAW_SESSION_ID } : {}),
    ...(process.env.YAW_SESSION_CODE ? { code: process.env.YAW_SESSION_CODE } : {}),
    ...(process.env.YAW_HOST_SECRET ? { hostSecret: process.env.YAW_HOST_SECRET } : {}),
    ...(process.env.YAW_JOIN_SECRET ? { joinSecret: process.env.YAW_JOIN_SECRET } : {}),
    voice,
    ...(showpackAssets ? { showpackAssets } : {}),
    ...(process.env.YAW_PRIVATE_MUSIC_PATH
      ? { privateMusicDirectory: resolve(process.env.YAW_PRIVATE_MUSIC_PATH) }
      : {}),
  });
  const started = await server.start();

  process.parentPort.postMessage({
    type: 'runtime-ready',
    started,
  });

  process.parentPort.on('message', (event) => {
    const message = event.data as ParentMessage;
    if (message.type === 'shutdown') {
      void server.stop().finally(() => process.exit(0));
    }
  });
}

void run().catch((error: unknown) => {
  process.parentPort.postMessage({
    type: 'runtime-error',
    category: startupFailureCategory,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
