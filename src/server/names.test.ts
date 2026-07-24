import { describe, expect, it } from 'vitest';

import { normalizeDisplayName } from './names.js';

describe('normalizeDisplayName', () => {
  it('normalizes whitespace and compatibility characters', () => {
    expect(normalizeDisplayName('  Ｒｉｌｅｙ   J  ')).toEqual({
      ok: true,
      name: 'Riley J',
    });
  });

  it('counts emoji as grapheme clusters rather than UTF-16 units', () => {
    expect(normalizeDisplayName('👨‍👩‍👧‍👦')).toEqual({ ok: true, name: '👨‍👩‍👧‍👦' });
  });

  it('rejects bidi controls that can visually spoof the host screen', () => {
    expect(normalizeDisplayName('safe\u202Etxt.exe')).toMatchObject({ ok: false });
  });
});
