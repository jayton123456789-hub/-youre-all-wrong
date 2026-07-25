import { resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import { validateShowpack } from '../domain/showpack/validate.js';
import { createGameServer } from './app.js';
import { EpisodeVoicePreflight, type VoiceRendererConfig } from './voice-preflight.js';

const validated = validateShowpack(demoPack);
if (!validated.ok) {
  throw new Error(
    `Bundled episode failed validation: ${JSON.stringify(validated.issues, null, 2)}`,
  );
}

const productionWebRoot = resolve(process.cwd(), 'dist/web');
const isProduction = process.env.NODE_ENV === 'production';
const useChatterbox = process.env.YAW_VOICE_ENGINE?.toLowerCase() === 'chatterbox';
const chatterboxModel = process.env.YAW_CHATTERBOX_MODEL?.toLowerCase() ?? 'turbo';
const voiceWorkerPath = resolve(
  process.env.YAW_VOICE_WORKER_PATH ??
    (useChatterbox ? 'services/chatterbox-voice-worker.ps1' : 'services/system-voice-worker.ps1'),
);
const voiceCacheDirectory = resolve(process.env.YAW_VOICE_CACHE_PATH ?? '.yallwrong/voice-cache');
const renderer: VoiceRendererConfig | undefined = useChatterbox
  ? {
      engineId: 'chatterbox-tts',
      modelRevision: `chatterbox-${chatterboxModel}-pip-0.1.7`,
      deliveryPresetRevision: 'yaw-chatterbox-delivery-v2',
      pronunciationRevision: 'whole-token-substitution-v2',
      postProcessingRevision: 'librosa-tempo-v1',
      voiceName: process.env.YAW_CHATTERBOX_VOICE_NAME ?? 'Local Chatterbox Host',
      voiceProfileHashSource: [
        chatterboxModel,
        process.env.YAW_CHATTERBOX_VOICE_ID ?? '',
        process.env.YAW_CHATTERBOX_REFERENCE ?? '',
      ].join(':'),
    }
  : undefined;
const voice = new EpisodeVoicePreflight({
  pack: validated.pack,
  cacheDirectory: voiceCacheDirectory,
  workerPath: voiceWorkerPath,
  ...(renderer ? { renderer } : {}),
});
const server = await createGameServer({
  pack: validated.pack,
  packHash: validated.packHash,
  port: Number(process.env.YAW_PORT ?? 4310),
  ...(!isProduction ? { publicWebPort: Number(process.env.YAW_WEB_PORT ?? 5173) } : {}),
  ...(isProduction ? { webRoot: productionWebRoot } : {}),
  databasePath: resolve(
    process.env.YAW_DATABASE_PATH ?? resolve(process.cwd(), '.yallwrong/runtime.sqlite'),
  ),
  voice,
});

const started = await server.start();

console.log('');
console.log("YOU'RE ALL WRONG! runtime ready");
console.log(`Voice: ${renderer?.voiceName ?? 'Microsoft David Desktop'}`);
if (renderer) console.log(`Neural model: ${chatterboxModel}`);
console.log(`Host: ${started.hostUrl}`);
for (const joinUrl of started.joinUrls) {
  console.log(`Phone: ${joinUrl}`);
}
console.log('');

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
