import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from '../domain/canonical.js';
import { makeTestShowpack } from '../domain/testkit/showpack.js';
import type { VoicePreflightService } from './voice-preflight.js';
import { createGameServer, type GameServer } from './app.js';

const resources: Array<{ server?: GameServer; directory: string }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ server, directory }) => {
      await server?.stop();
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function pcmWave(): Buffer {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(40, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

describe('voice preflight HTTP API', () => {
  it('keeps status, manifest, and cached audio behind the host secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yaw-voice-api-'));
    const audioPath = join(directory, 'opening-line.wav');
    await writeFile(audioPath, pcmWave());
    const hostSecret = randomBytes(32).toString('base64url');
    const voice: VoicePreflightService = {
      status: {
        state: 'ready',
        completed: 1,
        total: 1,
        rendered: 1,
        cached: 0,
        voiceName: 'Test Host',
        message: 'One line ready.',
      },
      manifest: {
        protocolVersion: 1,
        engineId: 'windows-system-speech',
        voiceName: 'Test Host',
        assets: [
          {
            cueId: 'opening-line',
            durationMs: 1,
            pauseBeforeMs: 0,
            pauseAfterMs: 250,
            delivery: 'conversational',
          },
        ],
      },
      fileForCue: (cueId) => (cueId === 'opening-line' ? audioPath : null),
      prepare: async () => undefined,
    };
    const pack = makeTestShowpack();
    const server = await createGameServer({
      pack,
      packHash: createHash('sha256').update(canonicalJson(pack)).digest('hex'),
      hostSecret,
      databasePath: join(directory, 'runtime.sqlite'),
      logger: false,
      voice,
    });
    resources.push({ server, directory });

    const unauthorized = await server.app.inject({ method: 'GET', url: '/api/voice/status' });
    expect(unauthorized.statusCode).toBe(401);

    const headers = { 'x-yaw-host-key': hostSecret };
    const status = await server.app.inject({
      method: 'GET',
      url: '/api/voice/status',
      headers,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: 'ready', total: 1 });

    const manifest = await server.app.inject({
      method: 'GET',
      url: '/api/voice/manifest',
      headers,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().assets).toHaveLength(1);

    const audio = await server.app.inject({
      method: 'GET',
      url: '/api/voice/audio/opening-line',
      headers,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    expect(audio.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });
});
