import type { Cue } from '../showpack/schema.js';

const MAX_PRERENDERED_PLAYERS = 8;
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
] as const;

type LineCue = Extract<Cue, { type: 'line' }>;

function validatePlayerNumber(playerNumber: number): number {
  if (
    !Number.isInteger(playerNumber) ||
    playerNumber < 1 ||
    playerNumber > MAX_PRERENDERED_PLAYERS
  ) {
    throw new Error(
      `Numbered player callouts currently support players 1-${MAX_PRERENDERED_PLAYERS}.`,
    );
  }
  return playerNumber;
}

export function playerCalloutCue(playerNumber: number): LineCue {
  const normalized = validatePlayerNumber(playerNumber);
  return {
    type: 'line',
    id: `runtime-player-callout-${normalized}`,
    speaker: 'host',
    text: `Player ${NUMBER_WORDS[normalized]}.`,
    delivery: 'announcer',
    pace: 0.96,
    energy: 0.62,
    pauseBeforeMs: 120,
    pauseAfterMs: 180,
    pronunciation: {},
  };
}

export function buildPlayerCalloutCues(maxPlayers: number): LineCue[] {
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
    throw new Error('A showpack must allow at least one player.');
  }
  if (maxPlayers > MAX_PRERENDERED_PLAYERS) {
    throw new Error(
      `The current numbered-callout voice bank supports at most ${MAX_PRERENDERED_PLAYERS} players.`,
    );
  }

  return Array.from({ length: maxPlayers }, (_, index) => playerCalloutCue(index + 1));
}
