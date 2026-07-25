import { describe, expect, it } from 'vitest';

import { buildPlayerGroupCalloutCues, playerGroupCalloutCue } from './player-callouts.js';

describe('player-number callouts', () => {
  it('speaks stable seat numbers instead of player-entered names', () => {
    expect(playerGroupCalloutCue([3]).text).toBe('Player three.');
    expect(playerGroupCalloutCue([3, 1]).text).toBe('Players one and three.');
    expect(playerGroupCalloutCue([4, 1, 3]).text).toBe('Players one, three, and four.');
  });

  it('prebuilds every non-empty combination for the supported lobby size', () => {
    const cues = buildPlayerGroupCalloutCues(3);
    expect(cues).toHaveLength(7);
    expect(cues.map((cue) => cue.id)).toContain('runtime-player-callout-1-2-3');
  });

  it('rejects player numbers outside the prerecorded one-through-eight bank', () => {
    expect(() => playerGroupCalloutCue([])).toThrow(/at least one player/u);
    expect(() => playerGroupCalloutCue([9])).toThrow(/players 1-8/u);
    expect(() => buildPlayerGroupCalloutCues(9)).toThrow(/at most 8 players/u);
  });
});
