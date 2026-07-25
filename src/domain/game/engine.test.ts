import { describe, expect, it } from 'vitest';

import { makeTestShowpack } from '../testkit/showpack.js';
import { applyEvents, decideGame, evolveGame } from './engine.js';
import { projectGame } from './projection.js';
import type { GameCommand, GameEvent, GameState } from './types.js';

const context = { pack: makeTestShowpack() };

function genesis(): GameState {
  return evolveGame(null, {
    type: 'session.created',
    at: 1_000,
    sessionId: 'session-1',
    code: 'WRONG',
    packHash: 'a'.repeat(64),
    seed: 42,
  });
}

function run(state: GameState, command: GameCommand): GameState {
  const decision = decideGame(context, state, command);
  if (!decision.ok) throw new Error(`${decision.code}: ${decision.message}`);
  return applyEvents(state, decision.events);
}

function openQuestion(): GameState {
  let state = genesis();
  state = run(state, { type: 'player.join', now: 1_100, playerId: 'p1', name: 'Riley' });
  state = run(state, { type: 'player.join', now: 1_200, playerId: 'p2', name: 'Marcus' });
  state = run(state, { type: 'host.start', now: 2_000 });
  return run(state, {
    type: 'host.advance',
    now: 3_000,
    nextPhaseToken: 'secure-phase-token',
  });
}

function presentAnswers(state: GameState, now = 3_000): GameState {
  return run(state, {
    type: 'host.answers_presented',
    now,
    questionId: 'question-one',
  });
}

describe('game engine', () => {
  it('keeps choices and answering unavailable while the prompt plays', () => {
    const state = openQuestion();
    const playerProjection = projectGame(state, context.pack, 'p1');
    const hostProjection = projectGame(state, context.pack);

    expect(state.currentQuestion).toMatchObject({
      timingPhase: 'prompt',
      openedAt: 3_000,
      answerWindowOpenedAt: null,
      deadlineAt: null,
      answerNarrationStatus: 'pending',
      answerNarrationEndedAt: null,
      answerNarrationEndReason: null,
    });
    expect(playerProjection.question).toMatchObject({
      timingPhase: 'prompt',
      promptStartedAt: 3_000,
      answerWindowOpenedAt: null,
      answerWindowDeadlineAt: null,
      answers: [],
    });
    expect(playerProjection.self?.phaseToken).toBeNull();
    expect(playerProjection.presentation).toBeNull();
    expect(hostProjection.presentation).toMatchObject({
      kind: 'question',
      stage: 'prompt',
    });
  });

  it('presents all answers and opens a fresh 20-second window after the prompt', () => {
    const state = presentAnswers(openQuestion(), 7_250);
    const projection = projectGame(state, context.pack, 'p1');

    expect(state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      promptEndedAt: 7_250,
      answerWindowOpenedAt: 7_250,
      deadlineAt: 27_250,
      answerNarrationStatus: 'playing',
      answerNarrationEndedAt: null,
      answerNarrationEndReason: null,
    });
    expect(projection.question?.answers).toHaveLength(4);
    expect(projection.self?.phaseToken).toBe('secure-phase-token');
  });

  it('finishes answer narration without moving the active deadline', () => {
    let state = presentAnswers(openQuestion(), 7_250);
    state = run(state, {
      type: 'host.answer_narration_complete',
      now: 10_000,
      questionId: 'question-one',
    });

    expect(state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      answerWindowOpenedAt: 7_250,
      deadlineAt: 27_250,
      answerNarrationStatus: 'completed',
      answerNarrationEndedAt: 10_000,
      answerNarrationEndReason: 'completed',
    });
  });

  it('rejects answers during the prompt', () => {
    const state = openQuestion();
    const answer = decideGame(context, state, {
      type: 'player.answer',
      now: 7_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });

    expect(answer).toMatchObject({ ok: false, code: 'answers_not_presented' });
  });

  it('cuts only answer narration on the first lock without restarting the timer', () => {
    let state = presentAnswers(openQuestion(), 7_000);
    const answer = decideGame(context, state, {
      type: 'player.answer',
      now: 8_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });
    expect(answer).toMatchObject({
      ok: true,
      events: [
        { type: 'answer.accepted' },
        {
          type: 'question.answer_narration_ended',
          reason: 'first_answer',
          triggeringPlayerId: 'p1',
        },
      ],
    });
    if (!answer.ok) return;
    state = applyEvents(state, answer.events);

    expect(state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      answerNarrationStatus: 'interrupted',
      answerNarrationEndedAt: 8_000,
      answerNarrationEndReason: 'first_answer',
      answerWindowOpenedAt: 7_000,
      deadlineAt: 27_000,
    });

    state = run(state, {
      type: 'player.answer',
      now: 13_000,
      playerId: 'p2',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });
    const secondAttempt = decideGame(context, state, {
      type: 'player.answer',
      now: 13_100,
      playerId: 'p2',
      questionId: 'question-one',
      answerId: 'wrong-b',
      phaseToken: 'secure-phase-token',
    });
    expect(secondAttempt).toMatchObject({ ok: false, code: 'answer_locked' });

    state = run(state, { type: 'host.reveal', now: 13_500, reason: 'host' });
    expect(state.reveal?.playerResults.find((result) => result.playerId === 'p1')).toMatchObject({
      responseMs: 1_000,
      scoreDelta: 1_475,
    });
    expect(state.reveal?.playerResults.find((result) => result.playerId === 'p2')).toMatchObject({
      responseMs: 6_000,
      scoreDelta: 1_350,
    });
    expect(state.players['p1']?.score).toBe(1_475);
    expect(state.players['p2']?.score).toBe(1_350);
  });

  it('keeps scoring deterministic and integer-only', () => {
    let state = presentAnswers(openQuestion());
    state = run(state, {
      type: 'player.answer',
      now: 8_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });
    state = run(state, {
      type: 'player.answer',
      now: 9_000,
      playerId: 'p2',
      questionId: 'question-one',
      answerId: 'wrong-b',
      phaseToken: 'secure-phase-token',
    });
    state = run(state, { type: 'host.reveal', now: 10_000, reason: 'host' });

    expect(state.players['p1']?.score).toBe(1_375);
    expect(state.players['p2']?.score).toBe(-250);
    expect(state.reveal?.ledger.map((entry) => entry.key)).toEqual([
      'question-one/p1/correct',
      'question-one/p1/speed',
      'question-one/p2/wrong',
    ]);
  });

  it('locks the first accepted answer', () => {
    let state = presentAnswers(openQuestion());
    state = run(state, {
      type: 'player.answer',
      now: 4_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'wrong-b',
      phaseToken: 'secure-phase-token',
    });

    const second = decideGame(context, state, {
      type: 'player.answer',
      now: 4_100,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });

    expect(second).toMatchObject({ ok: false, code: 'answer_locked' });
  });

  it('rejects stale phase tokens and late packets', () => {
    const state = presentAnswers(openQuestion());
    const stale = decideGame(context, state, {
      type: 'player.answer',
      now: 4_000,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'old-token',
    });
    const late = decideGame(context, state, {
      type: 'player.answer',
      now: 23_001,
      playerId: 'p1',
      questionId: 'question-one',
      answerId: 'correct-a',
      phaseToken: 'secure-phase-token',
    });

    expect(stale).toMatchObject({ ok: false, code: 'stale_phase' });
    expect(late).toMatchObject({ ok: false, code: 'answer_closed' });
  });

  it('never leaks the answer key or reactions to a player before reveal', () => {
    const state = presentAnswers(openQuestion());
    const projection = projectGame(state, context.pack, 'p1');
    const serialized = JSON.stringify(projection);

    expect(projection.question?.answers).toHaveLength(4);
    expect(projection.presentation).toBeNull();
    expect(serialized).not.toContain('correctAnswerId');
    expect(serialized).not.toContain('wrongAnswerReactions');
    expect(serialized).not.toContain('A complete and independent wrong-answer response.');
  });

  it('replays the same event tape into the same state', () => {
    const events: GameEvent[] = [
      {
        type: 'session.created',
        at: 1,
        sessionId: 'session-replay',
        code: 'REPLY',
        packHash: 'b'.repeat(64),
        seed: 8675309,
      },
      {
        type: 'player.joined',
        at: 2,
        player: {
          id: 'p1',
          name: 'Jenny',
          joinOrder: 0,
          connected: true,
          ready: false,
          score: 0,
          currentStreak: 0,
          bestStreak: 0,
        },
      },
      { type: 'show.started', at: 3 },
    ];

    expect(applyEvents(null, events)).toEqual(applyEvents(null, structuredClone(events)));
  });

  it('recovers question events written before narration timing was introduced', () => {
    const legacyQuestionOpened = {
      type: 'question.opened',
      at: 3_000,
      currentQuestion: {
        roundIndex: 0,
        questionIndex: 0,
        openedAt: 3_000,
        deadlineAt: 23_000,
        phaseToken: 'legacy-phase-token',
        eligiblePlayerIds: [],
        answers: {},
      },
    } as unknown as GameEvent;

    const state = evolveGame(genesis(), legacyQuestionOpened);
    expect(state.currentQuestion).toMatchObject({
      timingPhase: 'answering',
      promptEndedAt: 3_000,
      answerWindowOpenedAt: 3_000,
      deadlineAt: 23_000,
      answerNarrationStatus: 'completed',
      answerNarrationEndedAt: 3_000,
      answerNarrationEndReason: 'legacy',
    });
  });

  it('plays every distinct selected wrong-answer response in deterministic answer order', () => {
    const expandedPack = makeTestShowpack();
    const expandedContext = { pack: expandedPack };
    let state = genesis();
    for (const [index, playerId] of ['p1', 'p2', 'p3'].entries()) {
      const joined = decideGame(expandedContext, state, {
        type: 'player.join',
        now: 1_100 + index,
        playerId,
        name: `Player ${index + 1}`,
      });
      if (!joined.ok) throw new Error(joined.message);
      state = applyEvents(state, joined.events);
    }
    for (const command of [
      { type: 'host.start' as const, now: 2_000 },
      {
        type: 'host.advance' as const,
        now: 3_000,
        nextPhaseToken: 'secure-phase-token',
      },
      {
        type: 'host.answers_presented' as const,
        now: 3_500,
        questionId: 'question-one',
      },
    ]) {
      const decision = decideGame(expandedContext, state, command);
      if (!decision.ok) throw new Error(decision.message);
      state = applyEvents(state, decision.events);
    }
    for (const [playerId, answerId] of [
      ['p1', 'wrong-c'],
      ['p2', 'wrong-b'],
      ['p3', 'wrong-b'],
    ] as const) {
      const decision = decideGame(expandedContext, state, {
        type: 'player.answer',
        now: 4_000,
        playerId,
        questionId: 'question-one',
        answerId,
        phaseToken: 'secure-phase-token',
      });
      if (!decision.ok) throw new Error(decision.message);
      state = applyEvents(state, decision.events);
    }
    const reveal = decideGame(expandedContext, state, {
      type: 'host.reveal',
      now: 5_000,
      reason: 'host',
    });
    if (!reveal.ok) throw new Error(reveal.message);
    state = applyEvents(state, reveal.events);

    expect(state.reveal?.reactionIds).toEqual(['wrong:wrong-b', 'wrong:wrong-c']);
    expect(
      state.reveal?.playback
        .filter((cue) => cue.type === 'line')
        .map((cue) => cue.text)
        .slice(0, 2),
    ).toEqual([
      'A complete and independent wrong-answer response.',
      'That answer is independently wrong.',
    ]);
  });
});
