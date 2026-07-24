import type { CueSequence, Showpack } from '../showpack/schema.js';

export const RULESET_VERSION = 'yaw.core/1' as const;

export type GamePhase = 'lobby' | 'intro' | 'question' | 'reveal' | 'finale' | 'complete';

export interface PlayerState {
  id: string;
  name: string;
  joinOrder: number;
  connected: boolean;
  ready: boolean;
  score: number;
  currentStreak: number;
  bestStreak: number;
}

export interface AnswerSubmission {
  playerId: string;
  answerId: string;
  receivedAt: number;
}

export interface ScoreLedgerEntry {
  key: string;
  playerId: string;
  questionId: string;
  reason: 'correct' | 'speed' | 'wrong' | 'no_answer';
  points: number;
}

export interface PlayerQuestionResult {
  playerId: string;
  answerId: string | null;
  correct: boolean;
  responseMs: number | null;
  previousStreak: number;
  nextStreak: number;
  scoreDelta: number;
}

export interface RevealState {
  questionId: string;
  reason: 'host' | 'timer' | 'all_answered';
  correctAnswerId: string;
  answerCounts: Record<string, number>;
  playerResults: PlayerQuestionResult[];
  ledger: ScoreLedgerEntry[];
  reactionIds: string[];
  playback: CueSequence;
  revealedAt: number;
}

export interface CurrentQuestionState {
  roundIndex: number;
  questionIndex: number;
  openedAt: number;
  deadlineAt: number;
  phaseToken: string;
  eligiblePlayerIds: string[];
  answers: Record<string, AnswerSubmission>;
}

export interface GameState {
  sessionId: string;
  code: string;
  rulesetVersion: typeof RULESET_VERSION;
  packHash: string;
  seed: number;
  createdAt: number;
  phase: GamePhase;
  revision: number;
  players: Record<string, PlayerState>;
  currentQuestion: CurrentQuestionState | null;
  reveal: RevealState | null;
  flags: Record<string, boolean>;
}

export type GameCommand =
  | {
      type: 'player.join';
      now: number;
      playerId: string;
      name: string;
    }
  | {
      type: 'player.connection';
      now: number;
      playerId: string;
      connected: boolean;
    }
  | {
      type: 'player.ready';
      now: number;
      playerId: string;
      ready: boolean;
    }
  | {
      type: 'host.start';
      now: number;
    }
  | {
      type: 'host.advance';
      now: number;
      nextPhaseToken?: string;
    }
  | {
      type: 'host.reveal';
      now: number;
      reason: RevealState['reason'];
    }
  | {
      type: 'player.answer';
      now: number;
      playerId: string;
      questionId: string;
      answerId: string;
      phaseToken: string;
    }
  | {
      type: 'host.reset';
      now: number;
    };

export type GameEvent =
  | {
      type: 'session.created';
      at: number;
      sessionId: string;
      code: string;
      packHash: string;
      seed: number;
    }
  | {
      type: 'player.joined';
      at: number;
      player: PlayerState;
    }
  | {
      type: 'player.connection_changed';
      at: number;
      playerId: string;
      connected: boolean;
    }
  | {
      type: 'player.ready_changed';
      at: number;
      playerId: string;
      ready: boolean;
    }
  | {
      type: 'show.started';
      at: number;
    }
  | {
      type: 'question.opened';
      at: number;
      currentQuestion: CurrentQuestionState;
    }
  | {
      type: 'answer.accepted';
      at: number;
      submission: AnswerSubmission;
    }
  | {
      type: 'question.revealed';
      at: number;
      reveal: RevealState;
    }
  | {
      type: 'finale.started';
      at: number;
    }
  | {
      type: 'show.completed';
      at: number;
    }
  | {
      type: 'session.reset';
      at: number;
    };

export interface EventEnvelope {
  sessionId: string;
  sequence: number;
  eventId: string;
  event: GameEvent;
  previousHash: string;
  hash: string;
}

export type DecisionResult =
  | {
      ok: true;
      events: GameEvent[];
    }
  | {
      ok: false;
      code:
        | 'invalid_phase'
        | 'player_not_found'
        | 'player_exists'
        | 'game_already_started'
        | 'game_not_ready'
        | 'answer_locked'
        | 'answer_closed'
        | 'stale_question'
        | 'stale_phase'
        | 'invalid_answer'
        | 'missing_phase_token';
      message: string;
    };

export interface GameContext {
  pack: Showpack;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  score: number;
  rank: number;
}

export interface PublicQuestion {
  id: string;
  category: string;
  promptText: string;
  answers: Array<{ id: string; text: string; shortLabel?: string }>;
  openedAt: number;
  deadlineAt: number;
  answeredCount: number;
  eligibleCount: number;
}

export interface PublicReveal {
  questionId: string;
  correctAnswerId: string;
  correctAnswerText: string;
  answerCounts: Record<string, number>;
  reactionText: string[];
  standings: PublicPlayer[];
}

export interface GameSnapshot {
  sessionId: string;
  code: string;
  revision: number;
  phase: GamePhase;
  episode: {
    id: string;
    title: string;
  };
  players: PublicPlayer[];
  question: PublicQuestion | null;
  reveal: PublicReveal | null;
  finale: {
    calmLeadIn: string[];
    titleDrop: string[];
    outro: string[];
  } | null;
  self: {
    playerId: string;
    selectedAnswerId: string | null;
    phaseToken: string | null;
  } | null;
}
