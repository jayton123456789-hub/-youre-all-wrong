import { resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import { validateShowpack } from '../domain/showpack/validate.js';
import { createGameServer } from '../server/app.js';
import { EpisodeVoicePreflight, type VoiceRendererConfig } from '../server/voice-preflight.js';

interface ParentMessage {
  type: 'shutdown';
}

async function run(): Promise<void> {
  const validation = validateShowpack(demoPack);
  if (!validation.ok) {
    throw new Error(`Bundled episode is invalid: ${JSON.stringify(validation.issues)}`);
  }

  const useChatterbox = process.env.YAW_VOICE_ENGINE?.toLowerCase() === 'chatterbox';
  const configuredWorkerPath =
    process.env.YAW_VOICE_WORKER_PATH ??
    (useChatterbox ? 'services/chatterbox-voice-worker.ps1' : 'services/system-voice-worker.ps1');
  const renderer: VoiceRendererConfig | undefined = useChatterbox
    ? {
        engineId: 'chatterbox-tts',
        modelRevision: 'chatterbox-tts-pip-v1',
        deliveryPresetRevision: 'yaw-chatterbox-delivery-v1',
        pronunciationRevision: 'whole-token-substitution-v2',
        postProcessingRevision: 'chatterbox-native-wave-v1',
        voiceName: process.env.YAW_CHATTERBOX_VOICE_NAME ?? 'Local Chatterbox Host',
        voiceProfileHashSource:
          process.env.YAW_CHATTERBOX_VOICE_ID ??
          process.env.YAW_CHATTERBOX_REFERENCE ??
          'chatterbox-default-voice',
      }
    : undefined;
  const voice = process.env.YAW_VOICE_CACHE_PATH
    ? new EpisodeVoicePreflight({
        pack: validation.pack,
        cacheDirectory: resolve(process.env.YAW_VOICE_CACHE_PATH),
        workerPath: resolve(configuredWorkerPath),
        ...(renderer ? { renderer } : {}),
      })
    : undefined;
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
    ...(voice ? { voice } : {}),
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
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
