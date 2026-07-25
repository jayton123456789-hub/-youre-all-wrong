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
});
