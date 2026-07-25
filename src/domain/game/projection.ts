import type { CueSequence, Question, Showpack } from '../showpack/schema.js';
import type { GameSnapshot, GameState, HostPresentation, PublicPlayer } from './types.js';

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
      return presentation(
        'question',
        'prompt',
        `${state.sessionId}:question:${question.id}:prompt`,
        [
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

  if (state.phase === 'reveal' && state.reveal) {
    const playerParts =
      question?.answers === undefined
        ? []
        : state.reveal.playerResults.map((result) => ({
            id: `player-${result.playerId}`,
            cues:
              result.answerId === null
                ? question.noAnswerReaction
                : result.correct
                  ? question.correctReaction
                  : (question.wrongAnswerReactions[result.answerId] ?? question.noAnswerReaction),
          }));
    const selectedConditional = question?.conditionalReactions.find((reaction) =>
      state.reveal?.reactionIds.includes(reaction.id),
    );
    return presentation(
      'reveal',
      'reveal',
      `${state.sessionId}:reveal:${state.reveal.questionId}:${state.reveal.revealedAt}`,
      [
        ...playerParts,
        ...(selectedConditional
          ? [{ id: `group-${selectedConditional.id}`, cues: selectedConditional.cues }]
          : []),
        {
          id: 'explanation',
          cues: [...(question?.explanation ?? []), ...(question?.postQuestion ?? [])],
        },
      ],
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
