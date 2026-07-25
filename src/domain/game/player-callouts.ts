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
type StageCue = Extract<Cue, { type: 'stage' }>;

function normalizePlayerNumbers(playerNumbers: number[]): number[] {
  const normalized = [...new Set(playerNumbers)].sort((a, b) => a - b);
  if (normalized.length === 0) {
    throw new Error('A numbered player callout requires at least one player.');
  }
  if (
    normalized.some(
      (playerNumber) =>
        !Number.isInteger(playerNumber) ||
        playerNumber < 1 ||
        playerNumber > MAX_PRERENDERED_PLAYERS,
    )
  ) {
    throw new Error(
      `Numbered player callouts currently support players 1-${MAX_PRERENDERED_PLAYERS}.`,
    );
  }
  return normalized;
}

function playerNumberList(playerNumbers: number[]): string {
  const words = normalizePlayerNumbers(playerNumbers).map(
    (playerNumber) => NUMBER_WORDS[playerNumber]!,
  );
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;
}

export function playerGroupCalloutCue(playerNumbers: number[]): LineCue {
  const normalized = normalizePlayerNumbers(playerNumbers);
  const plural = normalized.length > 1;
  return {
    type: 'line',
    id: `runtime-player-callout-${normalized.join('-')}`,
    speaker: 'host',
    text: `${plural ? 'Players' : 'Player'} ${playerNumberList(normalized)}.`,
    delivery: 'announcer',
    pace: 0.96,
    energy: 0.62,
    pauseBeforeMs: 120,
    pauseAfterMs: 180,
    pronunciation: {},
  };
}

export function playerVerdictHoldCue(playerNumber: number): StageCue {
  const [normalized] = normalizePlayerNumbers([playerNumber]);
  return {
    type: 'stage',
    id: `runtime-player-verdict-${normalized}`,
    action: 'screen_shake',
    intensity: 0.28,
    durationMs: 260,
  };
}

export function buildPlayerGroupCalloutCues(maxPlayers: number): LineCue[] {
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
    throw new Error('A showpack must allow at least one player.');
  }
  if (maxPlayers > MAX_PRERENDERED_PLAYERS) {
    throw new Error(
      `The current numbered-callout voice bank supports at most ${MAX_PRERENDERED_PLAYERS} players.`,
    );
  }

  const cues: LineCue[] = [];
  const combinationCount = 1 << maxPlayers;
  for (let mask = 1; mask < combinationCount; mask += 1) {
    const playerNumbers: number[] = [];
    for (let index = 0; index < maxPlayers; index += 1) {
      if ((mask & (1 << index)) !== 0) playerNumbers.push(index + 1);
    }
    cues.push(playerGroupCalloutCue(playerNumbers));
  }
  return cues;
}
