import { describe, expect, it } from 'vitest';

import { buildPlayerCalloutCues, playerCalloutCue } from './player-callouts.js';

describe('player-number callouts', () => {
  it('speaks stable seat numbers instead of player-entered names', () => {
    expect(playerCalloutCue(1).text).toBe('Player one.');
    expect(playerCalloutCue(3).text).toBe('Player three.');
    expect(playerCalloutCue(8).text).toBe('Player eight.');
  });

  it('prebuilds only one reusable clip per supported seat', () => {
    const cues = buildPlayerCalloutCues(3);
    expect(cues).toHaveLength(3);
    expect(cues.map((cue) => cue.id)).toEqual([
      'runtime-player-callout-1',
      'runtime-player-callout-2',
      'runtime-player-callout-3',
    ]);
  });

  it('rejects player numbers outside the prerecorded one-through-eight bank', () => {
    expect(() => playerCalloutCue(0)).toThrow(/players 1-8/u);
    expect(() => playerCalloutCue(9)).toThrow(/players 1-8/u);
    expect(() => buildPlayerCalloutCues(9)).toThrow(/at most 8 players/u);
  });
});
