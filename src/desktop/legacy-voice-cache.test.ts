import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { migrateVerifiedLegacyVoiceCache } from './legacy-voice-cache.js';

function wave(): Buffer {
  const value = Buffer.alloc(46);
  value.write('RIFF', 0, 'ascii');
  value.writeUInt32LE(38, 4);
  value.write('WAVE', 8, 'ascii');
  return value;
}

describe('legacy voice cache migration', () => {
  it('imports only receipt-authenticated final WAV pairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yaw-legacy-cache-'));
    const source = join(root, 'Electron', 'voice-cache');
    const destination = join(root, 'YOU ARE ALL WRONG', 'voice-cache');
    await mkdir(source, { recursive: true });

    const validKey = 'a'.repeat(64);
    const validWave = wave();
    await writeFile(join(source, `${validKey}.wav`), validWave);
    await writeFile(
      join(source, `${validKey}.wav.json`),
      JSON.stringify({
        schemaVersion: 1,
        cacheKey: validKey,
        waveSha256: createHash('sha256').update(validWave).digest('hex'),
        durationMs: 1,
      }),
    );

    const invalidKey = 'b'.repeat(64);
    await writeFile(join(source, `${invalidKey}.wav`), validWave);
    await writeFile(
      join(source, `${invalidKey}.wav.json`),
      JSON.stringify({
        schemaVersion: 1,
        cacheKey: invalidKey,
        waveSha256: '0'.repeat(64),
        durationMs: 1,
      }),
    );
    await writeFile(join(source, `.${validKey}.part-123.wav`), validWave);

    const result = await migrateVerifiedLegacyVoiceCache(source, destination);

    expect(result).toEqual({ discovered: 2, imported: 1, skipped: 1 });
    expect((await readdir(destination)).sort()).toEqual([
      `${validKey}.wav`,
      `${validKey}.wav.json`,
    ]);
    expect(await readFile(join(destination, `${validKey}.wav`))).toEqual(validWave);
  });

  it('is safe when the legacy directory does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yaw-no-legacy-cache-'));
    await expect(
      migrateVerifiedLegacyVoiceCache(join(root, 'missing'), join(root, 'destination')),
    ).resolves.toEqual({ discovered: 0, imported: 0, skipped: 0 });
  });
});
