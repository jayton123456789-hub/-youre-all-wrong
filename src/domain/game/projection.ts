import { playerGroupCalloutCue } from './player-callouts.js';
import type { CueSequence, Question, Showpack } from '../showpack/schema.js';
import type {
  GameSnapshot,
  GameState,
  HostPresentation,
  PlayerQuestionResult,
  PublicPlayer,
} from './types.js';

function lineText(cues: CueSequence): string[] {
  return cues.filter((cue) => cue.type === 'line').map((cue) => cue.text);
}

function rankedPlayers(state: GameState): PublicPlayer[] {
  const sorted = Object.values(state.players).sort(
    (a, b) => b.score - a.score || a.joinOrder - b.joinOrder,
  );
  let previousScore: number | null = null;
  let previousRank = 0;

  return sorted.map((player, index) => {
    const rank = previousScore === player.score ? previousRank : index + 1;
    previousScore = player.score;
    previousRank = rank;
    return {
      id: player.id,
      name: player.name,
      connected: player.connected,
      ready: player.ready,
      score: player.score,
      rank,
    };
  });
}

function stableSelectionIndex(seed: number, key: string, length: number): number {
  if (length <= 0) throw new Error('Cannot select from an empty authored sequence list.');
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % length;
}

function presentation(
  kind: HostPresentation['kind'],
  stage: HostPresentation['stage'],
  sequenceId: string,
  parts: HostPresentation['parts'],
): HostPresentation {
  return {
    kind,
    stage,
    sequenceId,
    cues: structuredClone(parts.flatMap((part) => part.cues)),
    parts: structuredClone(parts),
  };
}

function finalePresentation(
  state: GameState,
  pack: Showpack,
  standings: PublicPlayer[],
): HostPresentation {
  const finale = pack.episode.finale;
  const winners = standings.filter((player) => player.rank === 1);
  const lastRank = standings.reduce((maximum, player) => Math.max(maximum, player.rank), 0);
  const lastPlace = standings.filter((player) => player.rank === lastRank && lastRank > 1);

  const winner = winners.length === 1 ? winners[0] : undefined;
  const loser = lastPlace.length === 1 ? lastPlace[0] : undefined;
  const winnerRoastIndex = winner
    ? stableSelectionIndex(
        state.seed,
        `${pack.episode.id}:${finale.id}:winner:${winner.id}`,
        finale.winnerRoasts.length,
      )
    : null;
  const loserRoastIndex = loser
    ? stableSelectionIndex(
        state.seed,
        `${pack.episode.id}:${finale.id}:loser:${loser.id}`,
        finale.loserRoasts.length,
      )
    : null;

  const parts: HostPresentation['parts'] = [
    { id: 'calm-lead-in', cues: finale.calmLeadIn },
    { id: 'title-drop', cues: finale.titleDrop },
    ...(winnerRoastIndex === null
      ? []
      : [{ id: `winner-roast-${winnerRoastIndex}`, cues: finale.winnerRoasts[winnerRoastIndex]! }]),
    ...(loserRoastIndex === null
      ? []
      : [{ id: `loser-roast-${loserRoastIndex}`, cues: finale.loserRoasts[loserRoastIndex]! }]),
    { id: 'outro', cues: finale.outro },
  ];

  return presentation(
    'finale',
    'finale',
    `${state.sessionId}:finale:${finale.id}:w${winnerRoastIndex ?? 'none'}:l${
      loserRoastIndex ?? 'none'
    }`,
    parts,
  );
}

interface RevealResultGroup {
  answerId: string | null;
  results: PlayerQuestionResult[];
}

function groupRevealResults(
  state: GameState,
  question: Question,
  results: PlayerQuestionResult[],
): RevealResultGroup[] {
  const groups = new Map<string, RevealResultGroup>();
  for (const result of results) {
    const key = result.answerId ?? '__no_answer__';
    const group = groups.get(key) ?? { answerId: result.answerId, results: [] };
    group.results.push(result);
    groups.set(key, group);
  }

  const answerOrder = new Map(question.answers.map((answer, index) => [answer.id, index]));
  return [...groups.values()]
    .map((group) => ({
      ...group,
      results: [...group.results].sort(
        (a, b) =>
          (state.players[a.playerId]?.joinOrder ?? Number.MAX_SAFE_INTEGER) -
          (state.players[b.playerId]?.joinOrder ?? Number.MAX_SAFE_INTEGER),
      ),
    }))
    .sort((a, b) => {
      const aCorrect = a.answerId === question.correctAnswerId;
      const bCorrect = b.answerId === question.correctAnswerId;
      if (aCorrect !== bCorrect) return aCorrect ? 1 : -1;
      if (a.answerId === null || b.answerId === null) {
        if (a.answerId === b.answerId) return 0;
        return a.answerId === null ? 1 : -1;
      }
      return (
        b.results.length - a.results.length ||
        (answerOrder.get(a.answerId) ?? Number.MAX_SAFE_INTEGER) -
          (answerOrder.get(b.answerId) ?? Number.MAX_SAFE_INTEGER)
      );
    });
}

function playerPartsForGroup(
  state: GameState,
  results: PlayerQuestionResult[],
  reaction: CueSequence,
  reactionId: string,
): HostPresentation['parts'] {
  if (results.length === 0) return [];

  const numberedResults = results.map((result) => {
    const player = state.players[result.playerId];
    if (!player) throw new Error(`Reveal referenced missing player "${result.playerId}".`);
    return { result, number: player.joinOrder + 1 };
  });

  if (numberedResults.length === 1) {
    const only = numberedResults[0]!;
    return [
      {
        id: `player-${only.result.playerId}`,
        cues: [playerGroupCalloutCue([only.number]), ...reaction],
      },
    ];
  }

  return [
    {
      id: `reaction-${reactionId}`,
      cues: [playerGroupCalloutCue(numberedResults.map(({ number }) => number)), ...reaction],
    },
    ...numberedResults.map(({ result, number }) => ({
      id: `player-${result.playerId}`,
      cues: [playerGroupCalloutCue([number])],
    })),
  ];
}

function revealPresentationParts(
  state: GameState,
  pack: Showpack,
  question: Question,
): HostPresentation['parts'] {
  if (!state.reveal) return [];

  const groups = groupRevealResults(state, question, state.reveal.playerResults);
  const selectedConditional = question.conditionalReactions.find((reaction) =>
    state.reveal?.reactionIds.includes(reaction.id),
  );
  const parts: HostPresentation['parts'] = [];

  if (selectedConditional) {
    parts.push(
      ...playerPartsForGroup(
        state,
        state.reveal.playerResults,
        selectedConditional.cues,
        `conditional-${selectedConditional.id}`,
      ),
      { id: 'correct-answer', cues: question.correctReaction },
    );
  } else {
    const correctGroup = groups.find((group) => group.answerId === question.correctAnswerId);
    for (const group of groups) {
      if (group.answerId === question.correctAnswerId) continue;
      const reaction =
        group.answerId === null
          ? question.noAnswerReaction
          : (question.wrongAnswerReactions[group.answerId] ?? question.noAnswerReaction);
      parts.push(
        ...playerPartsForGroup(state, group.results, reaction, group.answerId ?? 'no-answer'),
      );
    }

    if (correctGroup) {
      parts.push(
        ...playerPartsForGroup(
          state,
          correctGroup.results,
          question.correctReaction,
          question.correctAnswerId,
        ),
      );
    } else {
      parts.push({ id: 'correct-answer', cues: question.correctReaction });
    }
  }

  parts.push({
    id: 'explanation',
    cues: [...question.explanation, ...question.postQuestion],
  });
  const pointer = state.currentQuestion;
  const round = pointer ? pack.episode.rounds[pointer.roundIndex] : undefined;
  if (
    pointer &&
    round &&
    round.outro.length > 0 &&
    pointer.questionIndex === round.questions.length - 1
  ) {
    parts.push({ id: `round-${round.id}-outro`, cues: round.outro });
  }
  return parts;
}

function hostPresentation(
  state: GameState,
  pack: Showpack,
  question: Question | undefined,
  standings: PublicPlayer[],
  playerId: string | null,
): HostPresentation | null {
  if (playerId !== null) return null;

  if (state.phase === 'intro') {
    const firstRound = pack.episode.rounds[0];
    return presentation('intro', 'intro', `${state.sessionId}:intro:${pack.episode.id}`, [
      { id: 'episode-opening', cues: pack.episode.opening },
      { id: 'first-round-intro', cues: firstRound?.intro ?? [] },
    ]);
  }

  if (state.phase === 'question' && state.currentQuestion && question) {
    if (state.currentQuestion.timingPhase === 'prompt') {
      const round = pack.episode.rounds[state.currentQuestion.roundIndex];
      const laterRoundIntro =
        state.currentQuestion.questionIndex === 0 && state.currentQuestion.roundIndex > 0
          ? [
              {
                id: `round-${round?.id ?? state.currentQuestion.roundIndex}-intro`,
                cues: round?.intro ?? [],
              },
            ]
          : [];
      return presentation(
        'question',
        'prompt',
        `${state.sessionId}:question:${question.id}:prompt`,
        [
          ...laterRoundIntro,
          { id: 'category', cues: question.categoryIntro },
          { id: 'prompt', cues: question.prompt },
        ],
      );
    }

    if (state.currentQuestion.answerNarrationStatus === 'playing') {
      return presentation(
        'question',
        'answers',
        `${state.sessionId}:question:${question.id}:answers:${state.currentQuestion.answerWindowOpenedAt}`,
        question.answers.map((answer) => ({
          id: `answer-${answer.id}`,
          cues: answer.narration,
        })),
      );
    }

    return null;
  }

  if (state.phase === 'reveal' && state.reveal && question) {
    return presentation(
      'reveal',
      'reveal',
      `${state.sessionId}:reveal:${state.reveal.questionId}:${state.reveal.revealedAt}`,
      revealPresentationParts(state, pack, question),
    );
  }

  if (state.phase === 'finale') {
    return finalePresentation(state, pack, standings);
  }

  return null;
}

export function projectGame(
  state: GameState,
  pack: Showpack,
  playerId: string | null = null,
): GameSnapshot {
  const pointer = state.currentQuestion;
  const question = pointer
    ? pack.episode.rounds[pointer.roundIndex]?.questions[pointer.questionIndex]
    : undefined;

  const questionProjection =
    state.phase === 'question' && pointer && question
      ? (() => {
          const compatibilityOpenedAt = pointer.answerWindowOpenedAt ?? pointer.openedAt;
          const compatibilityDeadlineAt = pointer.deadlineAt ?? compatibilityOpenedAt;
          return {
            id: question.id,
            category: question.category,
            promptText: question.promptText,
            answers:
              pointer.timingPhase === 'answering'
                ? question.answers.map((answer) => ({
                    id: answer.id,
                    text: answer.text,
                    ...(answer.shortLabel === undefined ? {} : { shortLabel: answer.shortLabel }),
                  }))
                : [],
            timingPhase: pointer.timingPhase,
            promptStartedAt: pointer.openedAt,
            promptEndedAt: pointer.promptEndedAt,
            answerWindowOpenedAt: pointer.answerWindowOpenedAt,
            answerWindowDeadlineAt: pointer.deadlineAt,
            answerNarrationStatus: pointer.answerNarrationStatus,
            answerNarrationEndedAt: pointer.answerNarrationEndedAt,
            answerNarrationEndReason: pointer.answerNarrationEndReason,
            openedAt: compatibilityOpenedAt,
            deadlineAt: compatibilityDeadlineAt,
            answeredCount: Object.keys(pointer.answers).length,
            eligibleCount: pointer.eligiblePlayerIds.length,
          };
        })()
      : null;

  const standings = rankedPlayers(state);
  const revealProjection =
    state.phase === 'reveal' && state.reveal
      ? {
          questionId: state.reveal.questionId,
          correctAnswerId: state.reveal.correctAnswerId,
          correctAnswerText:
            question?.answers.find((answer) => answer.id === state.reveal?.correctAnswerId)?.text ??
            state.reveal.correctAnswerId,
          answers:
            question?.answers.map((answer) => ({
              id: answer.id,
              text: answer.text,
            })) ?? [],
          answerCounts: structuredClone(state.reveal.answerCounts),
          reactionText: lineText(state.reveal.playback),
          standings,
          playerResults: structuredClone(
            playerId === null
              ? state.reveal.playerResults
              : state.reveal.playerResults.filter((result) => result.playerId === playerId),
          ),
        }
      : null;

  return {
    sessionId: state.sessionId,
    code: state.code,
    revision: state.revision,
    phase: state.phase,
    episode: {
      id: pack.episode.id,
      title: pack.episode.title,
    },
    players: standings,
    question: questionProjection,
    reveal: revealProjection,
    finale:
      state.phase === 'finale' || state.phase === 'complete'
        ? {
            calmLeadIn: lineText(pack.episode.finale.calmLeadIn),
            titleDrop: lineText(pack.episode.finale.titleDrop),
            outro: lineText(pack.episode.finale.outro),
          }
        : null,
    presentation: hostPresentation(state, pack, question, standings, playerId),
    self:
      playerId && state.players[playerId]
        ? {
            playerId,
            selectedAnswerId: state.currentQuestion?.answers[playerId]?.answerId ?? null,
            phaseToken:
              state.phase === 'question' &&
              state.currentQuestion?.timingPhase === 'answering' &&
              state.currentQuestion?.eligiblePlayerIds.includes(playerId)
                ? state.currentQuestion.phaseToken
                : null,
          }
        : null,
  };
}
