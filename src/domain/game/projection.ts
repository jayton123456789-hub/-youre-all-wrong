import type { CueSequence, Showpack } from '../showpack/schema.js';
import type { GameSnapshot, GameState, PublicPlayer } from './types.js';

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
      ? {
          id: question.id,
          category: question.category,
          promptText: question.promptText,
          answers: question.answers.map((answer) => ({
            id: answer.id,
            text: answer.text,
            ...(answer.shortLabel === undefined ? {} : { shortLabel: answer.shortLabel }),
          })),
          openedAt: pointer.openedAt,
          deadlineAt: pointer.deadlineAt,
          answeredCount: Object.keys(pointer.answers).length,
          eligibleCount: pointer.eligiblePlayerIds.length,
        }
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
          answerCounts: structuredClone(state.reveal.answerCounts),
          reactionText: lineText(state.reveal.playback),
          standings,
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
    self:
      playerId && state.players[playerId]
        ? {
            playerId,
            selectedAnswerId: state.currentQuestion?.answers[playerId]?.answerId ?? null,
            phaseToken:
              state.phase === 'question' &&
              state.currentQuestion?.eligiblePlayerIds.includes(playerId)
                ? state.currentQuestion.phaseToken
                : null,
          }
        : null,
  };
}
