import { resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import { validateShowpack } from '../domain/showpack/validate.js';
import { createGameServer } from './app.js';
import { createQwenVoiceAdapterFromEnvironment } from './qwen-renderer.js';
import {
  EpisodeVoicePreflight,
  UnavailableVoicePreflight,
  type VoicePreflightService,
} from './voice-preflight.js';

const validated = validateShowpack(demoPack);
if (!validated.ok) {
  throw new Error(
    `Bundled episode failed validation: ${JSON.stringify(validated.issues, null, 2)}`,
  );
}

const productionWebRoot = resolve(process.cwd(), 'dist/web');
const isProduction = process.env.NODE_ENV === 'production';
const voiceCacheDirectory = resolve(process.env.YAW_VOICE_CACHE_PATH ?? '.yallwrong/voice-cache');
const voiceEngine = process.env.YAW_VOICE_ENGINE?.trim().toLowerCase();
let voice: VoicePreflightService;
let voiceDescription: string;

if (voiceEngine === 'qwen3-tts' || voiceEngine === 'qwen') {
  try {
    const adapter = await createQwenVoiceAdapterFromEnvironment(process.env);
    voice = new EpisodeVoicePreflight({
      pack: validated.pack,
      cacheDirectory: voiceCacheDirectory,
      workerPath: adapter.workerPath,
      renderer: adapter.renderer,
      runWorker: adapter.runWorker,
    });
    voiceDescription = `${adapter.renderer.voiceName} (Qwen3-TTS Base)`;
  } catch (error) {
    const message = `The neural host could not be configured: ${
      error instanceof Error ? error.message : String(error)
    }`;
    voice = new UnavailableVoicePreflight(message);
    voiceDescription = 'unavailable';
  }
} else if (voiceEngine === 'system-speech' || voiceEngine === 'sapi') {
  voice = new EpisodeVoicePreflight({
    pack: validated.pack,
    cacheDirectory: voiceCacheDirectory,
    workerPath: resolve(process.env.YAW_VOICE_WORKER_PATH ?? 'services/system-voice-worker.ps1'),
  });
  voiceDescription = 'Microsoft David Desktop (explicit development opt-in)';
} else {
  const message =
    process.env.YAW_VOICE_UNAVAILABLE_MESSAGE?.trim() ||
    (voiceEngine && voiceEngine !== 'unavailable'
      ? `Unsupported local voice engine "${voiceEngine}".`
      : 'No approved neural host is configured. Set up Qwen3-TTS before starting the show.');
  voice = new UnavailableVoicePreflight(message);
  voiceDescription = 'unavailable';
}
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
console.log(`Voice: ${voiceDescription}`);
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
