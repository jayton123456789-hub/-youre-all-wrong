import type { CueSequence, Question } from '../showpack/schema.js';
import {
  type DecisionResult,
  type GameCommand,
  type GameContext,
  type GameEvent,
  type GameState,
  type PlayerQuestionResult,
  type RevealState,
  RULESET_VERSION,
  type ScoreLedgerEntry,
} from './types.js';

function reject(
  code: Extract<DecisionResult, { ok: false }>['code'],
  message: string,
): DecisionResult {
  return { ok: false, code, message };
}

function currentQuestion(context: GameContext, state: GameState): Question | null {
  const pointer = state.currentQuestion;
  if (!pointer) return null;
  return context.pack.episode.rounds[pointer.roundIndex]?.questions[pointer.questionIndex] ?? null;
}

function firstQuestion(context: GameContext, now: number, phaseToken: string, state: GameState) {
  const question = context.pack.episode.rounds[0]?.questions[0];
  if (!question) throw new Error('Validated episodes must contain at least one question.');

  return {
    roundIndex: 0,
    questionIndex: 0,
    openedAt: now,
    deadlineAt: now + question.timeLimitMs,
    phaseToken,
    eligiblePlayerIds: Object.values(state.players)
      .filter((player) => player.connected)
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((player) => player.id),
    answers: {},
  };
}

function nextQuestionPointer(
  context: GameContext,
  state: GameState,
): {
  roundIndex: number;
  questionIndex: number;
  question: Question;
} | null {
  const current = state.currentQuestion;
  if (!current) return null;

  const round = context.pack.episode.rounds[current.roundIndex];
  const nextInRound = round?.questions[current.questionIndex + 1];
  if (nextInRound) {
    return {
      roundIndex: current.roundIndex,
      questionIndex: current.questionIndex + 1,
      question: nextInRound,
    };
  }

  const nextRound = context.pack.episode.rounds[current.roundIndex + 1];
  const firstInNextRound = nextRound?.questions[0];
  if (firstInNextRound) {
    return {
      roundIndex: current.roundIndex + 1,
      questionIndex: 0,
      question: firstInNextRound,
    };
  }

  return null;
}

function integerTimeBonus(maxBonus: number, remainingMs: number, durationMs: number): number {
  if (maxBonus === 0 || remainingMs <= 0) return 0;
  return Number((BigInt(maxBonus) * BigInt(remainingMs)) / BigInt(durationMs));
}

function conditionMatches(
  condition: Question['conditionalReactions'][number]['when'],
  state: GameState,
  question: Question,
  results: PlayerQuestionResult[],
): boolean {
  const answered = results.filter((result) => result.answerId !== null);
  switch (condition.kind) {
    case 'unanimous_answer':
      return (
        answered.length === results.length &&
        answered.length > 0 &&
        answered.every((result) => result.answerId === condition.answerId)
      );
    case 'all_correct':
      return results.length > 0 && results.every((result) => result.correct);
    case 'solo_correct':
      return results.filter((result) => result.correct).length === 1;
    case 'fast_answer':
      return results.some(
        (result) =>
          result.answerId === condition.answerId &&
          result.responseMs !== null &&
          result.responseMs <= condition.withinMs,
      );
    case 'streak_broken':
      return results.some(
        (result) => !result.correct && result.previousStreak >= condition.minimumStreak,
      );
    case 'callback_flag':
      return (state.flags[condition.flag] ?? false) === condition.value;
    default:
      return false;
  }
}

function chooseReactions(
  state: GameState,
  question: Question,
  results: PlayerQuestionResult[],
): Array<{ id: string; cues: CueSequence }> {
  const conditional = [...question.conditionalReactions]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .find((candidate) => conditionMatches(candidate.when, state, question, results));

  if (conditional) {
    return [{ id: conditional.id, cues: conditional.cues }];
  }

  const wrongCounts = new Map<string, number>();
  for (const result of results) {
    if (result.answerId !== null && !result.correct) {
      wrongCounts.set(result.answerId, (wrongCounts.get(result.answerId) ?? 0) + 1);
    }
  }

  const answerOrder = new Map(question.answers.map((answer, index) => [answer.id, index]));
  const selectedWrongAnswers = [...wrongCounts.entries()]
    .sort(
      ([answerA, countA], [answerB, countB]) =>
        countB - countA ||
        (answerOrder.get(answerA) ?? Number.MAX_SAFE_INTEGER) -
          (answerOrder.get(answerB) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([answerId]) => ({
      id: `wrong:${answerId}`,
      cues: question.wrongAnswerReactions[answerId] ?? [],
    }));

  if (selectedWrongAnswers.length > 0) {
    return selectedWrongAnswers;
  }

  return [
    {
      id: 'correct:default',
      cues: question.correctReaction,
    },
  ];
}

function buildReveal(
  context: GameContext,
  state: GameState,
  now: number,
  reason: RevealState['reason'],
): RevealState {
  const pointer = state.currentQuestion;
  const question = currentQuestion(context, state);
  if (!pointer || !question) throw new Error('Cannot reveal without a current question.');

  const answerCounts = Object.fromEntries(question.answers.map((answer) => [answer.id, 0]));
  const ledger: ScoreLedgerEntry[] = [];
  const playerResults: PlayerQuestionResult[] = [];

  for (const playerId of pointer.eligiblePlayerIds) {
    const player = state.players[playerId];
    if (!player) continue;

    const submission = pointer.answers[playerId];
    const answerId = submission?.answerId ?? null;
    const correct = answerId === question.correctAnswerId;
    const responseMs = submission ? Math.max(0, submission.receivedAt - pointer.openedAt) : null;
    let scoreDelta = 0;

    if (answerId !== null) {
      answerCounts[answerId] = (answerCounts[answerId] ?? 0) + 1;
    }

    if (correct && responseMs !== null) {
      const duration = pointer.deadlineAt - pointer.openedAt;
      const remaining = Math.max(0, pointer.deadlineAt - (submission?.receivedAt ?? now));
      const speedPoints = integerTimeBonus(question.scoring.speedBonus, remaining, duration);
      scoreDelta = question.scoring.correct + speedPoints;
      ledger.push({
        key: `${question.id}/${playerId}/correct`,
        playerId,
        questionId: question.id,
        reason: 'correct',
        points: question.scoring.correct,
      });
      if (speedPoints > 0) {
        ledger.push({
          key: `${question.id}/${playerId}/speed`,
          playerId,
          questionId: question.id,
          reason: 'speed',
          points: speedPoints,
        });
      }
    } else if (answerId !== null) {
      scoreDelta = -question.scoring.wrongPenalty;
      if (question.scoring.wrongPenalty > 0) {
        ledger.push({
          key: `${question.id}/${playerId}/wrong`,
          playerId,
          questionId: question.id,
          reason: 'wrong',
          points: -question.scoring.wrongPenalty,
        });
      }
    } else {
      scoreDelta = -question.scoring.noAnswerPenalty;
      if (question.scoring.noAnswerPenalty > 0) {
        ledger.push({
          key: `${question.id}/${playerId}/no-answer`,
          playerId,
          questionId: question.id,
          reason: 'no_answer',
          points: -question.scoring.noAnswerPenalty,
        });
      }
    }

    playerResults.push({
      playerId,
      answerId,
      correct,
      responseMs,
      previousStreak: player.currentStreak,
      nextStreak: correct ? player.currentStreak + 1 : 0,
      scoreDelta,
    });
  }

  const reactions = chooseReactions(state, question, playerResults);
  const reactionCues = reactions.flatMap((reaction) => reaction.cues);
  const onlyDefaultCorrect = reactions.length === 1 && reactions[0]?.id === 'correct:default';
  const playback = onlyDefaultCorrect
    ? [...reactionCues, ...question.explanation, ...question.postQuestion]
    : [
        ...reactionCues,
        ...question.correctReaction,
        ...question.explanation,
        ...question.postQuestion,
      ];

  return {
    questionId: question.id,
    reason,
    correctAnswerId: question.correctAnswerId,
    answerCounts,
    playerResults,
    ledger,
    reactionIds: reactions.map((reaction) => reaction.id),
    playback,
    revealedAt: now,
  };
}

export function decideGame(
  context: GameContext,
  state: GameState,
  command: GameCommand,
): DecisionResult {
  switch (command.type) {
    case 'player.join': {
      if (state.phase !== 'lobby') {
        return reject('game_already_started', 'New players can only join while the lobby is open.');
      }
      if (state.players[command.playerId]) {
        return reject('player_exists', 'That player slot already exists.');
      }
      if (Object.keys(state.players).length >= context.pack.manifest.maxPlayers) {
        return reject('game_not_ready', 'This room is full.');
      }

      return {
        ok: true,
        events: [
          {
            type: 'player.joined',
            at: command.now,
            player: {
              id: command.playerId,
              name: command.name,
              joinOrder: Object.keys(state.players).length,
              connected: true,
              ready: false,
              score: 0,
              currentStreak: 0,
              bestStreak: 0,
            },
          },
        ],
      };
    }

    case 'player.connection': {
      if (!state.players[command.playerId]) {
        return reject('player_not_found', 'Player does not exist.');
      }
      return {
        ok: true,
        events: [
          {
            type: 'player.connection_changed',
            at: command.now,
            playerId: command.playerId,
            connected: command.connected,
          },
        ],
      };
    }

    case 'player.ready': {
      if (state.phase !== 'lobby') {
        return reject('invalid_phase', 'Ready state can only change in the lobby.');
      }
      if (!state.players[command.playerId]) {
        return reject('player_not_found', 'Player does not exist.');
      }
      return {
        ok: true,
        events: [
          {
            type: 'player.ready_changed',
            at: command.now,
            playerId: command.playerId,
            ready: command.ready,
          },
        ],
      };
    }

    case 'host.start': {
      if (state.phase !== 'lobby') {
        return reject('invalid_phase', 'The show can only start from the lobby.');
      }
      const players = Object.values(state.players).filter((player) => player.connected);
      if (players.length < context.pack.manifest.minPlayers) {
        return reject(
          'game_not_ready',
          `At least ${context.pack.manifest.minPlayers} connected player(s) are required.`,
        );
      }
      return { ok: true, events: [{ type: 'show.started', at: command.now }] };
    }

    case 'host.advance': {
      if (state.phase === 'intro') {
        if (!command.nextPhaseToken) {
          return reject('missing_phase_token', 'Opening a question requires a phase token.');
        }
        return {
          ok: true,
          events: [
            {
              type: 'question.opened',
              at: command.now,
              currentQuestion: firstQuestion(context, command.now, command.nextPhaseToken, state),
            },
          ],
        };
      }

      if (state.phase === 'reveal') {
        const next = nextQuestionPointer(context, state);
        if (!next) {
          return { ok: true, events: [{ type: 'finale.started', at: command.now }] };
        }
        if (!command.nextPhaseToken) {
          return reject('missing_phase_token', 'Opening a question requires a phase token.');
        }

        return {
          ok: true,
          events: [
            {
              type: 'question.opened',
              at: command.now,
              currentQuestion: {
                roundIndex: next.roundIndex,
                questionIndex: next.questionIndex,
                openedAt: command.now,
                deadlineAt: command.now + next.question.timeLimitMs,
                phaseToken: command.nextPhaseToken,
                eligiblePlayerIds: Object.values(state.players)
                  .filter((player) => player.connected)
                  .sort((a, b) => a.joinOrder - b.joinOrder)
                  .map((player) => player.id),
                answers: {},
              },
            },
          ],
        };
      }

      if (state.phase === 'finale') {
        return { ok: true, events: [{ type: 'show.completed', at: command.now }] };
      }

      return reject('invalid_phase', `Cannot advance while the game is in "${state.phase}".`);
    }

    case 'player.answer': {
      if (state.phase !== 'question' || !state.currentQuestion) {
        return reject('answer_closed', 'Answers are not currently open.');
      }
      if (!state.players[command.playerId]) {
        return reject('player_not_found', 'Player does not exist.');
      }
      const question = currentQuestion(context, state);
      if (!question || command.questionId !== question.id) {
        return reject('stale_question', 'That answer belongs to a different question.');
      }
      if (command.phaseToken !== state.currentQuestion.phaseToken) {
        return reject('stale_phase', 'That answer window is no longer active.');
      }
      if (!state.currentQuestion.eligiblePlayerIds.includes(command.playerId)) {
        return reject('answer_closed', 'This player was not eligible when the question opened.');
      }
      if (command.now > state.currentQuestion.deadlineAt) {
        return reject('answer_closed', 'The answer arrived after the deadline.');
      }
      if (state.currentQuestion.answers[command.playerId]) {
        return reject('answer_locked', 'The first accepted answer is final.');
      }
      if (!question.answers.some((answer) => answer.id === command.answerId)) {
        return reject('invalid_answer', 'That answer is not a choice for this question.');
      }

      return {
        ok: true,
        events: [
          {
            type: 'answer.accepted',
            at: command.now,
            submission: {
              playerId: command.playerId,
              answerId: command.answerId,
              receivedAt: command.now,
            },
          },
        ],
      };
    }

    case 'host.reveal': {
      if (state.phase !== 'question') {
        return reject('invalid_phase', 'There is no open question to reveal.');
      }
      return {
        ok: true,
        events: [
          {
            type: 'question.revealed',
            at: command.now,
            reveal: buildReveal(context, state, command.now, command.reason),
          },
        ],
      };
    }

    case 'host.reset':
      return { ok: true, events: [{ type: 'session.reset', at: command.now }] };
  }
}

export function evolveGame(previous: GameState | null, event: GameEvent): GameState {
  if (event.type === 'session.created') {
    if (previous) throw new Error('session.created can only be applied at genesis.');
    return {
      sessionId: event.sessionId,
      code: event.code,
      rulesetVersion: RULESET_VERSION,
      packHash: event.packHash,
      seed: event.seed,
      createdAt: event.at,
      phase: 'lobby',
      revision: 1,
      players: {},
      currentQuestion: null,
      reveal: null,
      flags: {},
    };
  }

  if (!previous) throw new Error(`Cannot apply ${event.type} before session.created.`);
  const state = structuredClone(previous);
  state.revision += 1;

  switch (event.type) {
    case 'player.joined':
      state.players[event.player.id] = structuredClone(event.player);
      break;
    case 'player.connection_changed':
      if (state.players[event.playerId]) {
        state.players[event.playerId]!.connected = event.connected;
      }
      break;
    case 'player.ready_changed':
      if (state.players[event.playerId]) {
        state.players[event.playerId]!.ready = event.ready;
      }
      break;
    case 'show.started':
      state.phase = 'intro';
      state.currentQuestion = null;
      state.reveal = null;
      break;
    case 'question.opened':
      state.phase = 'question';
      state.currentQuestion = structuredClone(event.currentQuestion);
      state.reveal = null;
      break;
    case 'answer.accepted':
      if (state.currentQuestion) {
        state.currentQuestion.answers[event.submission.playerId] = structuredClone(
          event.submission,
        );
      }
      break;
    case 'question.revealed':
      state.phase = 'reveal';
      state.reveal = structuredClone(event.reveal);
      for (const result of event.reveal.playerResults) {
        const player = state.players[result.playerId];
        if (!player) continue;
        player.score += result.scoreDelta;
        player.currentStreak = result.nextStreak;
        player.bestStreak = Math.max(player.bestStreak, result.nextStreak);
      }
      break;
    case 'finale.started':
      state.phase = 'finale';
      state.currentQuestion = null;
      state.reveal = null;
      break;
    case 'show.completed':
      state.phase = 'complete';
      break;
    case 'session.reset':
      state.phase = 'lobby';
      state.currentQuestion = null;
      state.reveal = null;
      state.flags = {};
      for (const player of Object.values(state.players)) {
        player.score = 0;
        player.currentStreak = 0;
        player.bestStreak = 0;
        player.ready = false;
      }
      break;
  }

  return state;
}

export function applyEvents(initial: GameState | null, events: GameEvent[]): GameState {
  let state = initial;
  for (const event of events) {
    state = evolveGame(state, event);
  }
  if (!state) throw new Error('Event list did not produce a state.');
  return state;
}
