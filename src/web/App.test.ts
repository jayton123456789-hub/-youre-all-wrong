import { describe, expect, it } from 'vitest';

import type { PublicPlayer } from '../domain/game/types.js';
import { orderScoreboardPlayers, voiceActivityPresentation } from './App.js';

function player(id: string, score: number): PublicPlayer {
  return {
    id,
    name: id,
    connected: true,
    ready: true,
    score,
    rank: 1,
  };
}

describe('host scoreboard ordering', () => {
  it('uses the stable reveal seat order when concealed scores tie', () => {
    const finalScoreOrder = [player('fast-correct', 1_500), player('seat-one', -250)];

    const displayed = orderScoreboardPlayers(
      finalScoreOrder,
      {
        'fast-correct': 0,
        'seat-one': 0,
      },
      ['seat-one', 'fast-correct'],
    );

    expect(displayed.map(({ player: displayedPlayer }) => displayedPlayer.id)).toEqual([
      'seat-one',
      'fast-correct',
    ]);
  });

  it('allows settled score differences to change the displayed order', () => {
    const finalScoreOrder = [player('fast-correct', 1_500), player('seat-one', -250)];

    const displayed = orderScoreboardPlayers(
      finalScoreOrder,
      {
        'fast-correct': 1_500,
        'seat-one': 0,
      },
      ['seat-one', 'fast-correct'],
    );

    expect(displayed.map(({ player: displayedPlayer }) => displayedPlayer.id)).toEqual([
      'fast-correct',
      'seat-one',
    ]);
  });

  it('does not use final snapshot order for players outside the reveal order', () => {
    const finalScoreOrder = [player('z-player', 800), player('a-player', 800)];

    const displayed = orderScoreboardPlayers(
      finalScoreOrder,
      {
        'z-player': 0,
        'a-player': 0,
      },
      [],
    );

    expect(displayed.map(({ player: displayedPlayer }) => displayedPlayer.id)).toEqual([
      'a-player',
      'z-player',
    ]);
  });
});

describe('voice activity presentation', () => {
  it('keeps ordinary retries and deferred rescue work visually distinct', () => {
    expect(
      voiceActivityPresentation({
        type: 'quality-retry',
        attempt: 2,
        maximumAttempts: 3,
      }),
    ).toEqual({
      mode: 'retry',
      label: 'QUALITY PASS',
      recovered: false,
    });
    expect(
      voiceActivityPresentation({
        type: 'quality-deferred',
        parkedCount: 1,
      }),
    ).toEqual({
      mode: 'rescue',
      label: 'QUALITY RESCUE',
      recovered: false,
    });
  });

  it('uses the finished rescue treatment only after recovery', () => {
    expect(
      voiceActivityPresentation({
        type: 'quality-rescue-attempt',
        rescueIndex: 1,
        rescueTotal: 8,
        attempt: 2,
        maximumAttempts: 9,
      }).recovered,
    ).toBe(false);
    expect(
      voiceActivityPresentation({
        type: 'quality-rescue-recovered',
        remainingParked: 0,
      }),
    ).toMatchObject({
      mode: 'rescue',
      label: 'QUALITY RESCUE',
      recovered: true,
    });
  });
});
