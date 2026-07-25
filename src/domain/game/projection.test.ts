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

function introState(pack: Showpack): GameState {
  let state = genesis();
  state = run(pack, state, {
    type: 'player.join',
    now: 1_100,
    playerId: 'p1',
    name: 'Riley',
  });
  state = run(pack, state, {
    type: 'player.join',
    now: 1_200,
    playerId: 'p2',
    name: 'Marcus',
  });
  return run(pack, state, { type: 'host.start', now: 2_000 });
}

function promptState(pack: Showpack): GameState {
  return run(pack, introState(pack), {
    type: 'host.advance',
    now: 3_000,
    nextPhaseToken: 'secure-phase-token',
  });
}

function answerBoardState(pack: Showpack): GameState {
  return run(pack, promptState(pack), {
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
      'player-p1',
      'player-p2',
      'explanation',
    ]);
    expect(
      hostReveal.presentation?.cues.filter((cue) => cue.type === 'line').map((cue) => cue.id),
    ).toEqual(['question-one-correct', 'question-one-wrong-b']);
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
