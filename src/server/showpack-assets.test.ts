import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTestShowpack } from '../domain/testkit/showpack.js';
import { loadShowpackAssetLibrary } from './showpack-assets.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yaw-runtime-assets-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('runtime showpack asset library', () => {
  it('builds an ID lookup only after verifying bytes and SHA-256', async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from('licensed test sting');
    const pack = makeTestShowpack();
    pack.manifest.assets = [
      {
        id: 'sting',
        path: 'assets/audio/sting.wav',
        kind: 'audio',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        license: 'CC0-1.0',
        attribution: '',
      },
    ];
    await mkdir(join(root, 'assets/audio'), { recursive: true });
    await writeFile(join(root, 'assets/audio/sting.wav'), bytes);

    const library = await loadShowpackAssetLibrary(pack, root);

    expect(library?.fileForId('sting')).toMatchObject({
      id: 'sting',
      kind: 'audio',
      bytes: bytes.length,
    });
    expect(library?.fileForId('missing')).toBeNull();
  });

  it('rejects tampered persisted media', async () => {
    const root = await temporaryDirectory();
    const expected = Buffer.from('expected');
    const pack = makeTestShowpack();
    pack.manifest.assets = [
      {
        id: 'sting',
        path: 'sting.wav',
        kind: 'audio',
        bytes: expected.length,
        sha256: createHash('sha256').update(expected).digest('hex'),
        license: 'CC0-1.0',
        attribution: '',
      },
    ];
    await writeFile(join(root, 'sting.wav'), Buffer.from('tampered'));

    await expect(loadShowpackAssetLibrary(pack, root)).rejects.toThrow('SHA-256');
  });

  it('rejects declared assets when no media root is configured', async () => {
    const pack = makeTestShowpack();
    pack.manifest.assets = [
      {
        id: 'sting',
        path: 'sting.wav',
        kind: 'audio',
        bytes: 1,
        sha256: 'a'.repeat(64),
        license: 'CC0-1.0',
        attribution: '',
      },
    ];

    await expect(loadShowpackAssetLibrary(pack, undefined)).rejects.toThrow(
      'no persisted asset directory',
    );
  });
});
