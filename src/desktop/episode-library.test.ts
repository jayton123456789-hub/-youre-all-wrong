import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import { demoPack } from '../content/demo-pack.js';
import {
  activeShowpackPath,
  clearActiveEpisode,
  importEpisodeFile,
  loadActiveEpisode,
  persistActiveEpisode,
  showpackLibraryPath,
} from './episode-library.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yaw-episode-library-'));
  temporaryDirectories.push(directory);
  return directory;
}

function archivedPackWithAsset(id: string, contents: Uint8Array) {
  const pack = structuredClone(demoPack);
  pack.manifest.id = id;
  pack.episode.id = id;
  pack.manifest.assets = [
    {
      id: 'theme-sting',
      path: 'assets/audio/theme.wav',
      kind: 'audio',
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
      license: 'CC0-1.0',
      attribution: '',
    },
  ];
  return {
    pack,
    archive: zipSync({
      'manifest.json': strToU8(JSON.stringify(pack.manifest)),
      'episode/script.json': strToU8(JSON.stringify(pack.episode)),
      'assets/audio/theme.wav': contents,
    }),
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('desktop episode library', () => {
  it('validates a raw JSON episode document', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'episode.json');
    await writeFile(source, JSON.stringify(demoPack), 'utf8');

    const imported = await importEpisodeFile(source);

    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.pack.episode.title).toBe(demoPack.episode.title);
  });

  it('validates a .showpack archive through the hardened archive importer', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'episode.showpack');
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify(demoPack.manifest)),
      'episode/script.json': strToU8(JSON.stringify(demoPack.episode)),
    });
    await writeFile(source, archive);

    const imported = await importEpisodeFile(source);

    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.packHash).toHaveLength(64);
  });

  it('rejects malformed episode JSON with a visible issue', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'episode.json');
    await writeFile(source, '{"manifest":', 'utf8');

    const imported = await importEpisodeFile(source);

    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.issues[0]?.code).toBe('invalid_json');
  });

  it('rejects raw JSON that declares media it cannot contain', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'episode.json');
    const { pack } = archivedPackWithAsset('json-with-media', strToU8('media'));
    await writeFile(source, JSON.stringify(pack), 'utf8');

    const imported = await importEpisodeFile(source);

    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.issues[0]?.code).toBe('raw_json_missing_assets');
  });

  it('atomically preserves the complete archive and verified extracted assets', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'media.showpack');
    const mediaBytes = strToU8('licensed audio bytes');
    const { archive } = archivedPackWithAsset('media-episode', mediaBytes);
    await writeFile(source, archive);
    const imported = await importEpisodeFile(source);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const persisted = await persistActiveEpisode(directory, imported.pack, imported.archive);

    expect(persisted.assetRoot).not.toBeNull();
    expect(persisted.archivePath).not.toBeNull();
    expect(await readFile(join(persisted.assetRoot!, 'assets/audio/theme.wav'))).toEqual(
      Buffer.from(mediaBytes),
    );
    expect(await readFile(persisted.archivePath!)).toEqual(Buffer.from(archive));

    const loaded = await loadActiveEpisode(directory);
    expect(loaded.state.episode.source).toBe('custom');
    expect(loaded.assetRoot).toBe(persisted.assetRoot);
    expect(loaded.archivePath).toBe(persisted.archivePath);
  });

  it('will not pair a validated archive with a different episode script', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'first.showpack');
    const first = archivedPackWithAsset('media-owner-one', strToU8('same media'));
    const second = archivedPackWithAsset('media-owner-two', strToU8('same media'));
    await writeFile(source, first.archive);
    const imported = await importEpisodeFile(source);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    await expect(persistActiveEpisode(directory, second.pack, imported.archive)).rejects.toThrow(
      'does not belong',
    );
  });

  it('rejects tampered persisted assets and removes stale media on replacement or demo', async () => {
    const directory = await temporaryDirectory();
    const firstSource = join(directory, 'first.showpack');
    const first = archivedPackWithAsset('media-first', strToU8('first media'));
    await writeFile(firstSource, first.archive);
    const firstImport = await importEpisodeFile(firstSource);
    expect(firstImport.ok).toBe(true);
    if (!firstImport.ok) return;
    const firstPersisted = await persistActiveEpisode(
      directory,
      firstImport.pack,
      firstImport.archive,
    );

    await writeFile(join(firstPersisted.assetRoot!, 'assets/audio/theme.wav'), 'tampered!');
    const rejected = await loadActiveEpisode(directory);
    expect(rejected.state.episode.source).toBe('demo');
    expect(rejected.state.warning).toContain('media failed its integrity check');

    const secondSource = join(directory, 'second.showpack');
    const second = archivedPackWithAsset('media-second', strToU8('second media'));
    await writeFile(secondSource, second.archive);
    const secondImport = await importEpisodeFile(secondSource);
    expect(secondImport.ok).toBe(true);
    if (!secondImport.ok) return;
    const secondPersisted = await persistActiveEpisode(
      directory,
      secondImport.pack,
      secondImport.archive,
    );

    await expect(access(firstPersisted.archivePath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(showpackLibraryPath(directory))).toHaveLength(1);
    await clearActiveEpisode(directory);
    await expect(access(secondPersisted.archivePath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists canonical custom state and can return to the bundled demo', async () => {
    const directory = await temporaryDirectory();
    await writeFile(activeShowpackPath(directory), '{"stale":true}', 'utf8');
    await persistActiveEpisode(directory, demoPack);

    const saved = await readFile(activeShowpackPath(directory), 'utf8');
    expect(saved).not.toContain('  ');

    const custom = await loadActiveEpisode(directory);
    expect(custom.state.episode.source).toBe('custom');
    expect(custom.packPath).toBe(activeShowpackPath(directory));

    await clearActiveEpisode(directory);
    const fallback = await loadActiveEpisode(directory);
    expect(fallback.state.episode.source).toBe('demo');
    expect(fallback.packPath).toBeNull();
  });

  it('falls back to the bundled demo when persisted data is invalid', async () => {
    const directory = await temporaryDirectory();
    await writeFile(activeShowpackPath(directory), '{"wrong":true}', 'utf8');

    const loaded = await loadActiveEpisode(directory);

    expect(loaded.state.episode.source).toBe('demo');
    expect(loaded.state.warning).toContain('saved custom episode was rejected');
  });
});
