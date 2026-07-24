import { resolve } from 'node:path';

import { demoPack } from '../content/demo-pack.js';
import { validateShowpack } from '../domain/showpack/validate.js';
import { createGameServer } from './app.js';

const validated = validateShowpack(demoPack);
if (!validated.ok) {
  throw new Error(
    `Bundled episode failed validation: ${JSON.stringify(validated.issues, null, 2)}`,
  );
}

const productionWebRoot = resolve(process.cwd(), 'dist/web');
const isProduction = process.env.NODE_ENV === 'production';
const server = await createGameServer({
  pack: validated.pack,
  packHash: validated.packHash,
  port: Number(process.env.YAW_PORT ?? 4310),
  ...(!isProduction ? { publicWebPort: Number(process.env.YAW_WEB_PORT ?? 5173) } : {}),
  ...(isProduction ? { webRoot: productionWebRoot } : {}),
  databasePath: resolve(process.cwd(), '.yallwrong/runtime.sqlite'),
});

const started = await server.start();

console.log('');
console.log("YOU'RE ALL WRONG! runtime ready");
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
