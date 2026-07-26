import { describe, expect, it } from 'vitest';

import type { Cue, Showpack } from '../showpack/schema.js';
import { makeTestShowpack } from '../testkit/showpack.js';
import { applyEvents, decideGame, evolveGame } from './engine.js';
import { projectGame } from './projection.js';
import type { GameCommand, GameState } from './types.js';

function line(id: string, text: string): Extract<Cue, { type: 'line' }> {
  return {
    type: 'line',
    id,
    speaker: 'host',
    text,
    delivery: 'conversational',
    pace: 1,
    energy: 0.5,
    pauseBeforeMs: 0,
    pauseAfterMs: 100,
    pronunciation: {},
  };
}

function genesis(): GameState {
  return evolveGame(null, {
    type: 'session.created',
    at: 1_000,
    sessionId: 'projection-session',
    code: 'WRONG',
    packHash: 'a'.repeat(64),
    seed: 42,
  });
}

function run(pack: Showpack, state: GameState, command: GameCommand): GameState {
  const decision = decideGame({ pack }, state, command);
  if (!decision.ok) throw new Error(`${decision.code}: ${decision.message}`);
  return applyEvents(state, decision.events);
}

interface TestPlayer {
  id: string;
  name: string;
}

const DEFAULT_PLAYERS: TestPlayer[] = [
  { id: 'p1', name: 'Riley' },
  { id: 'p2', name: 'Marcus' },
];

function introState(pack: Showpack, players: TestPlayer[] = DEFAULT_PLAYERS): GameState {
  let state = genesis();
  players.forEach((player, index) => {
    state = run(pack, state, {
      type: 'player.join',
      now: 1_100 + index * 100,
      playerId: player.id,
      name: player.name,
    });
  });
  return run(pack, state, { type: 'host.start', now: 2_000 });
}

function promptState(pack: Showpack, players: TestPlayer[] = DEFAULT_PLAYERS): GameState {
  return run(pack, introState(pack, players), {
    type: 'host.advance',
    now: 3_000,
    nextPhaseToken: 'secure-phase-token',
  });
}

function answerBoardState(pack: Showpack, players: TestPlayer[] = DEFAULT_PLAYERS): GameState {
  return run(pack, promptState(pack, players), {
    type: 'host.answers_presented',
    now: 4_000,
    questionId: 'question-one',
  });
}

describe('game projections', () => {
  it('gives only the host authored intro and prompt cue sequences', () => {
    const pack = makeTestShowpack();
    pack.episode.rounds[0]!.intro = [line('round-intro-line', 'Host-only round intro.')];
    pack.episode.rounds[0]!.questions[0]!.categoryIntro = [
      line('category-intro-line', 'Host-only category intro.'),
    ];

    const intro = introState(pack);
    const hostIntro = projectGame(intro, pack);
    const playerIntro = projectGame(intro, pack, 'p1');

    expect(hostIntro.presentation).toMatchObject({
      kind: 'intro',
      stage: 'intro',
      parts: [{ id: 'episode-opening' }, { id: 'first-round-intro' }],
    });
    expect(hostIntro.presentation?.cues.map((cue) => cue.id)).toEqual([
      'opening-line',
      'round-intro-line',
    ]);
    expect(playerIntro.presentation).toBeNull();
    expect(JSON.stringify(playerIntro)).not.toContain('Host-only round intro.');

    const prompt = run(pack, intro, {
      type: 'host.advance',
      now: 3_000,
      nextPhaseToken: 'secure-phase-token',
    });
    const hostPrompt = projectGame(prompt, pack);
    const playerPrompt = projectGame(prompt, pack, 'p1');

    expect(hostPrompt.presentation).toMatchObject({
      kind: 'question',
      stage: 'prompt',
      parts: [{ id: 'category' }, { id: 'prompt' }],
    });
    expect(hostPrompt.presentation?.cues.map((cue) => cue.id)).toEqual([
      'category-intro-line',
      'question-one-prompt',
    ]);
    expect(playerPrompt.presentation).toBeNull();
    expect(playerPrompt.question?.answers).toEqual([]);
    expect(playerPrompt.self?.phaseToken).toBeNull();
    expect(JSON.stringify(playerPrompt)).not.toContain('Host-only category intro.');
    expect(JSON.stringify(playerPrompt)).not.toContain('question-one-correct-a-choice');
  });

  it('separates answer narration and keeps its sequence stable until a lock interrupts it', () => {
    const pack = makeTestShowpack();
    let state = answerBoardState(pack);
    const firstHostProjection = projectGame(state, pack);
    const playerProjection = projectGame(state, pack, 'p1');

    expect(firstHostProjection.presentation).toMatchObject({
      kind: 'question',
      stage: 'answers',
      parts: [
        { id: 'answer-correct-a' },
        { id: 'answer-wrong-b' },
        { id: 'answer-wrong-c' },
        { id: 'answer-wrong-d' },
      ],
    });
    expect(firstHostProjection.presentation?.cues.map((cue) => cue.id)).toEqual([
      'question-one-correct-a-choice',
      'question-one-wrong-b-choice',
      'question-one-wrong-c-choice',
      'question-one-wrong-d-choice',
    ]);
    expect(playerProjection.presentation).toBeNull();
    expect(playerProjection.question?.answers).toHaveLength(4);
    expect(playerProjection.self?.phaseToken).toBe('secure-phase-token');
    expect(JSON.stringify(playerProjection)).not.toContain('question-one-correct-a-choice');

    state = run(pack, state, {
      type: 'player.connection',
      now: 4_100,
      playerId: 'p2',
      connected: false,
    });
    expect(projectGame(state, pack).presentation?.sequenceId).toBe(
      firstHostProjection.presentation?.sequenceId,
    );

    state = run(pack, state, {
      type: 'player.answer',
      now: 5_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });

    expect(state.currentQuestion).toMatchObject({
      answerWindowOpenedAt: 4_000,
      deadlineAt: 24_000,
      answerNarrationStatus: 'interrupted',
      answerNarrationEndReason: 'first_answer',
    });
    expect(projectGame(state, pack).presentation).toBeNull();
  });

  it('plays each authored round outro and later-round intro at the transition boundary', () => {
    const pack = makeTestShowpack();
    const secondQuestion = structuredClone(pack.episode.rounds[0]!.questions[0]!);
    secondQuestion.id = 'question-two';
    secondQuestion.prompt = [line('question-two-prompt', 'This is the second question.')];
    secondQuestion.promptText = 'This is the second question.';
    pack.episode.rounds[0]!.outro = [line('round-one-outro-line', 'Round one is over.')];
    pack.episode.rounds.push({
      type: 'standard',
      id: 'round-two',
      title: 'Round Two',
      intro: [line('round-two-intro-line', 'Round two begins.')],
      questions: [secondQuestion],
      outro: [],
    });

    let state = answerBoardState(pack);
    for (const [playerId, answerId] of [
      ['p1', 'correct-a'],
      ['p2', 'wrong-b'],
    ] as const) {
      state = run(pack, state, {
        type: 'player.answer',
        now: 5_000,
        playerId,
        questionId: 'question-one',
        answerId,
        phaseToken: 'secure-phase-token',
      });
    }
    state = run(pack, state, { type: 'host.reveal', now: 6_000, reason: 'host' });

    const revealParts = projectGame(state, pack).presentation?.parts ?? [];
    expect(revealParts.at(-1)).toMatchObject({
      id: 'round-round-one-outro',
      cues: [expect.objectContaining({ id: 'round-one-outro-line' })],
    });

    state = run(pack, state, {
      type: 'host.advance',
      now: 7_000,
      nextPhaseToken: 'second-phase-token',
    });
    const secondPrompt = projectGame(state, pack).presentation;
    expect(secondPrompt?.parts.slice(0, 3).map((part) => part.id)).toEqual([
      'round-round-two-intro',
      'category',
      'prompt',
    ]);
    expect(secondPrompt?.cues.map((cue) => cue.id)).toContain('round-two-intro-line');
  });

  it('plays each selected answer reaction once and uses stable numbered group callouts', () => {
    const pack = makeTestShowpack();
    let state = answerBoardState(pack, [
      { id: 'p1', name: 'Riley' },
      { id: 'p2', name: 'Marcus' },
      { id: 'p3', name: 'Jayton' },
    ]);

    for (const [playerId, answerId, now] of [
      ['p1', 'wrong-b', 5_000],
      ['p2', 'wrong-b', 5_100],
      ['p3', 'correct-a', 5_200],
    ] as const) {
      state = run(pack, state, {
        type: 'player.answer',
        now,
        playerId,
        questionId: 'question-one',
        answerId,
        phaseToken: 'secure-phase-token',
      });
    }
    state = run(pack, state, { type: 'host.reveal', now: 6_000, reason: 'host' });

    const presentation = projectGame(state, pack).presentation;
    expect(presentation?.parts.map((part) => part.id)).toEqual([
      'reaction-wrong-b',
      'player-p1',
      'player-p2',
      'player-p3',
      'explanation',
    ]);
    expect(presentation?.parts[0]?.cues.map((cue) => cue.id)).toEqual(['question-one-wrong-b']);
    expect(presentation?.parts[1]?.cues.map((cue) => cue.id)).toEqual(['runtime-player-callout-1']);
    expect(presentation?.parts[2]?.cues.map((cue) => cue.id)).toEqual(['runtime-player-callout-2']);
    expect(presentation?.parts[3]?.cues.map((cue) => cue.id)).toEqual([
      'runtime-player-callout-3',
      'question-one-correct',
    ]);
    const spokenIds =
      presentation?.cues.filter((cue) => cue.type === 'line').map((cue) => cue.id) ?? [];
    expect(spokenIds.filter((id) => id === 'question-one-wrong-b')).toHaveLength(1);
    expect(spokenIds.filter((id) => id === 'question-one-correct')).toHaveLength(1);
  });

  it('projects reveal and deterministic safe finale cues to the host only', () => {
    const pack = makeTestShowpack();
    pack.episode.finale.winnerRoasts.push([line('winner-roast-two', 'Alternate winner roast.')]);
    pack.episode.finale.loserRoasts.push([line('loser-roast-two', 'Alternate loser roast.')]);

    let state = answerBoardState(pack);
    state = run(pack, state, {
      type: 'player.answer',
      now: 5_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });
    state = run(pack, state, {
      type: 'player.answer',
      now: 6_000,
      playerId: 'p2',
      questionId: 'question-one',
      answerId: 'wrong-b',
      phaseToken: 'secure-phase-token',
    });
    state = run(pack, state, { type: 'host.reveal', now: 7_000, reason: 'host' });

    const hostReveal = projectGame(state, pack);
    expect(hostReveal.presentation).toMatchObject({ kind: 'reveal', stage: 'reveal' });
    expect(hostReveal.presentation?.parts.map((part) => part.id)).toEqual([
      'player-p2',
      'player-p1',
      'explanation',
    ]);
    expect(
      hostReveal.presentation?.cues.filter((cue) => cue.type === 'line').map((cue) => cue.id),
    ).toEqual([
      'runtime-player-callout-2',
      'question-one-wrong-b',
      'runtime-player-callout-1',
      'question-one-correct',
    ]);
    expect(hostReveal.reveal?.answers).toHaveLength(4);
    expect(hostReveal.reveal?.playerResults).toHaveLength(2);
    const playerReveal = projectGame(state, pack, 'p1');
    expect(playerReveal.presentation).toBeNull();
    expect(playerReveal.reveal?.playerResults).toEqual([
      expect.objectContaining({ playerId: 'p1', correct: true }),
    ]);

    state = run(pack, state, { type: 'host.advance', now: 8_000 });
    const firstFinale = projectGame(state, pack);
    const secondFinale = projectGame(structuredClone(state), structuredClone(pack));
    const finalePartIds = firstFinale.presentation?.parts.map((part) => part.id) ?? [];

    expect(firstFinale.presentation).toMatchObject({ kind: 'finale', stage: 'finale' });
    expect(finalePartIds.some((id) => id.startsWith('winner-roast-'))).toBe(true);
    expect(finalePartIds.some((id) => id.startsWith('loser-roast-'))).toBe(true);
    expect(secondFinale.presentation).toEqual(firstFinale.presentation);
    expect(projectGame(state, pack, 'p1').presentation).toBeNull();
  });

  it('keeps pre-question scores and ranks on phones until reveal finishes', () => {
    const pack = makeTestShowpack();
    let state = answerBoardState(pack);
    state.players.p1!.score = 1_000;
    state.players.p2!.score = 500;

    state = run(pack, state, {
      type: 'player.answer',
      now: 5_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'wrong-b',
      phaseToken: 'secure-phase-token',
    });
    state = run(pack, state, {
      type: 'player.answer',
      now: 6_000,
      playerId: 'p2',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });
    state = run(pack, state, { type: 'host.reveal', now: 7_000, reason: 'host' });

    const hostReveal = projectGame(state, pack);
    expect(hostReveal.players.map(({ id, score, rank }) => ({ id, score, rank }))).toEqual([
      { id: 'p2', score: 1_950, rank: 1 },
      { id: 'p1', score: 750, rank: 2 },
    ]);
    expect(
      hostReveal.reveal?.standings.map(({ id, score, rank }) => ({ id, score, rank })),
    ).toEqual([
      { id: 'p2', score: 1_950, rank: 1 },
      { id: 'p1', score: 750, rank: 2 },
    ]);

    for (const playerId of ['p1', 'p2']) {
      const phoneReveal = projectGame(state, pack, playerId);
      const expectedStandings = [
        { id: 'p1', score: 1_000, rank: 1 },
        { id: 'p2', score: 500, rank: 2 },
      ];
      expect(phoneReveal.players.map(({ id, score, rank }) => ({ id, score, rank }))).toEqual(
        expectedStandings,
      );
      expect(
        phoneReveal.reveal?.standings.map(({ id, score, rank }) => ({ id, score, rank })),
      ).toEqual(expectedStandings);
    }

    state = run(pack, state, { type: 'host.advance', now: 8_000 });
    const phoneFinale = projectGame(state, pack, 'p1');
    expect(phoneFinale.players.map(({ id, score, rank }) => ({ id, score, rank }))).toEqual([
      { id: 'p2', score: 1_950, rank: 1 },
      { id: 'p1', score: 750, rank: 2 },
    ]);
  });

  it('omits singular winner and loser roasts when every player ties', () => {
    const pack = makeTestShowpack();
    let state = answerBoardState(pack);
    for (const playerId of ['p1', 'p2']) {
      state = run(pack, state, {
        type: 'player.answer',
        now: 5_000,
        playerId,
        questionId: 'question-one',
        answerId: 'correct-a',
        phaseToken: 'secure-phase-token',
      });
    }
    state = run(pack, state, { type: 'host.reveal', now: 6_000, reason: 'host' });
    state = run(pack, state, { type: 'host.advance', now: 7_000 });

    const partIds = projectGame(state, pack).presentation?.parts.map((part) => part.id) ?? [];
    expect(partIds).toEqual(['calm-lead-in', 'title-drop', 'outro']);
  });
});
