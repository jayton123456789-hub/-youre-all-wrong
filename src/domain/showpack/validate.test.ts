import { describe, expect, it } from 'vitest';

import { makeTestShowpack } from '../testkit/showpack.js';
import { validateShowpack } from './validate.js';

describe('validateShowpack', () => {
  it('accepts a semantically complete pack and produces a stable hash', () => {
    const pack = makeTestShowpack();
    const first = validateShowpack(pack);
    const second = validateShowpack(structuredClone(pack));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.packHash).toHaveLength(64);
      expect(first.packHash).toBe(second.packHash);
    }
  });

  it('rejects packs larger than the prerecorded eight-player voice bank', () => {
    const pack = makeTestShowpack();
    pack.manifest.maxPlayers = 9;

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.includes('/manifest/maxPlayers'))).toBe(true);
    }
  });

  it('reserves runtime cue IDs for generated player callouts', () => {
    const pack = makeTestShowpack();
    pack.episode.opening[0]!.id = 'runtime-player-callout-1';

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'reserved_runtime_id',
            path: '/episode/opening/0/id',
          }),
        ]),
      );
    }
  });

  it('rejects a missing independent wrong-answer reaction', () => {
    const pack = makeTestShowpack();
    delete pack.episode.rounds[0]!.questions[0]!.wrongAnswerReactions['wrong-b'];

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_wrong_reaction',
          }),
        ]),
      );
    }
  });

  it('rejects duplicate cue IDs across the episode', () => {
    const pack = makeTestShowpack();
    pack.episode.finale.titleDrop[0]!.id = pack.episode.opening[0]!.id;

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'duplicate_id')).toBe(true);
    }
  });

  it('rejects path traversal before any asset extraction can occur', () => {
    const pack = makeTestShowpack();
    pack.manifest.assets.push({
      id: 'bad-asset',
      path: '../outside.exe',
      kind: 'audio',
      sha256: 'a'.repeat(64),
      bytes: 10,
      license: 'MIT',
      attribution: '',
    });

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.includes('/assets/0/path'))).toBe(true);
    }
  });

  it('defaults authored sound playback to a blocking one-shot', () => {
    const pack = makeTestShowpack();
    pack.manifest.assets.push({
      id: 'sting',
      path: 'sting.wav',
      kind: 'audio',
      sha256: 'a'.repeat(64),
      bytes: 10,
      license: 'CC0-1.0',
      attribution: '',
    });
    pack.episode.opening.push({
      type: 'sound',
      id: 'opening-sting',
      assetId: 'sting',
      action: 'play',
      gainDb: -3,
      fadeMs: 0,
    } as never);

    const result = validateShowpack(pack);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const cue = result.pack.episode.opening.at(-1);
      expect(cue?.type === 'sound' && cue.loop).toBe(false);
    }
  });

  it('rejects sound cues that point at non-audio media', () => {
    const pack = makeTestShowpack();
    pack.manifest.assets.push({
      id: 'poster',
      path: 'poster.png',
      kind: 'image',
      sha256: 'a'.repeat(64),
      bytes: 10,
      license: 'CC0-1.0',
      attribution: '',
    });
    pack.episode.opening.push({
      type: 'sound',
      id: 'play-the-poster',
      assetId: 'poster',
      action: 'play',
      gainDb: 0,
      fadeMs: 0,
      loop: false,
    });

    const result = validateShowpack(pack);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'sound_asset_not_audio',
          }),
        ]),
      );
    }
  });
});
