import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { makeTestShowpack } from '../testkit/showpack.js';
import { importShowpackArchive } from './archive.js';

function archiveWith(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 1 });
}

describe('importShowpackArchive', () => {
  it('imports the canonical two-file archive', async () => {
    const pack = makeTestShowpack();
    const archive = archiveWith({
      'manifest.json': strToU8(JSON.stringify(pack.manifest)),
      'episode/script.json': strToU8(JSON.stringify(pack.episode)),
    });

    const result = await importShowpackArchive(archive);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.archiveHash).toHaveLength(64);
      expect(result.pack.episode.id).toBe('test-episode');
    }
  });

  it.each(['../escape.json', '/absolute.json', 'C:/windows.json', 'folder\\escape.json'])(
    'rejects unsafe path %s',
    async (path) => {
      const pack = makeTestShowpack();
      const archive = archiveWith({
        'manifest.json': strToU8(JSON.stringify(pack.manifest)),
        'episode/script.json': strToU8(JSON.stringify(pack.episode)),
        [path]: strToU8('hostile'),
      });

      const result = await importShowpackArchive(archive);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.code).toBe('invalid_archive');
      }
    },
  );

  it('rejects undeclared files even when their paths are safe', async () => {
    const pack = makeTestShowpack();
    const archive = archiveWith({
      'manifest.json': strToU8(JSON.stringify(pack.manifest)),
      'episode/script.json': strToU8(JSON.stringify(pack.episode)),
      'assets/audio/surprise.exe': strToU8('not actually an executable'),
    });

    const result = await importShowpackArchive(archive);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'undeclared_file',
        }),
      ]);
    }
  });
});
