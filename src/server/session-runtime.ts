import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { applyEvents, decideGame, evolveGame, projectGame } from '../domain/game/index.js';
import type { GameCommand, GameSnapshot, GameState } from '../domain/game/index.js';
import type {
  HostCommand,
  PlayerAnswer,
  PlayerJoin,
  PlayerReady,
  PlayerResume,
  ProtocolAck,
} from '../domain/protocol.js';
import type { Showpack } from '../domain/showpack/schema.js';
import { SqliteEventStore, type CredentialRecord } from './event-store.js';
import { normalizeDisplayName } from './names.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISCONNECT_GRACE_MS = 15_000;
const ALL_ANSWERED_REVEAL_DELAY_MS = 650;

function roomCode(): string {
  return Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeHashEqual(expectedHex: string, candidate: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(digest(candidate), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface SessionRuntimeOptions {
  pack: Showpack;
  packHash: string;
  store?: SqliteEventStore;
  now?: () => number;
  sessionId?: string;
  code?: string;
  hostSecret?: string;
  joinSecret?: string;
}

export interface SessionIdentity {
  sessionId: string;
  code: string;
  hostSecret: string;
  joinSecret: string;
}

export type StateListener = (state: GameState) => void;

export class SessionRuntime {
  readonly identity: SessionIdentity;
  readonly pack: Showpack;
  readonly packHash: string;
  readonly #store: SqliteEventStore;
  readonly #ownsStore: boolean;
  readonly #now: () => number;
  readonly #hostSecretHash: string;
  readonly #joinSecretHash: string;
  readonly #listeners = new Set<StateListener>();
  readonly #joinResponseCache = new Map<string, ProtocolAck<JoinRuntimeSuccess>>();
  readonly #disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #state: GameState;
  #deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  #commandQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionRuntimeOptions) {
    this.pack = options.pack;
    this.packHash = options.packHash;
    this.#store = options.store ?? new SqliteEventStore();
    this.#ownsStore = options.store === undefined;
    this.#now = options.now ?? Date.now;
    const sessionId = options.sessionId ?? randomUUID();
    const persistedEvents = this.#store.readEvents(sessionId);
    const recoveredState =
      persistedEvents.length > 0
        ? applyEvents(
            null,
            persistedEvents.map((envelope) => envelope.event),
          )
        : null;
    if (recoveredState && recoveredState.packHash !== this.packHash) {
      throw new Error('The persisted session pins a different episode hash.');
    }
    if (recoveredState && options.code && recoveredState.code !== options.code) {
      throw new Error('The persisted session room code does not match the runtime identity.');
    }

    this.identity = {
      sessionId,
      code: recoveredState?.code ?? options.code ?? roomCode(),
      hostSecret: options.hostSecret ?? secret(),
      joinSecret: options.joinSecret ?? secret(18),
    };
    this.#hostSecretHash = digest(this.identity.hostSecret);
    this.#joinSecretHash = digest(this.identity.joinSecret);

    if (recoveredState) {
      if (!this.#store.verifyEventChain(this.identity.sessionId)) {
        throw new Error('The persisted session event chain failed verification.');
      }
      this.#state = recoveredState;
      this.#scheduleDeadline();
    } else {
      const genesis = {
        type: 'session.created' as const,
        at: this.#now(),
        sessionId: this.identity.sessionId,
        code: this.identity.code,
        packHash: this.packHash,
        seed: randomInt(0, 0x7fffffff),
      };
      this.#store.append(this.identity.sessionId, 0, [genesis]);
      this.#state = evolveGame(null, genesis);
    }
  }

  get state(): GameState {
    return structuredClone(this.#state);
  }

  get hostSnapshot(): GameSnapshot {
    return projectGame(this.#state, this.pack, null);
  }

  playerSnapshot(playerId: string): GameSnapshot {
    return projectGame(this.#state, this.pack, playerId);
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  verifyHostSecret(candidate: string): boolean {
    return safeHashEqual(this.#hostSecretHash, candidate);
  }

  verifyJoinSecret(candidate: string | undefined): boolean {
    return candidate === undefined || safeHashEqual(this.#joinSecretHash, candidate);
  }

  verifyConnectionLease(playerId: string, connectionEpoch: number): boolean {
    return (
      this.#store.readCredential(this.identity.sessionId, playerId)?.connectionEpoch ===
      connectionEpoch
    );
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.#commandQueue.then(work, work);
    this.#commandQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      listener(this.state);
    }
  }

  #clearDeadline(): void {
    if (this.#deadlineTimer) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = null;
    }
  }

  #scheduleDeadline(): void {
    this.#clearDeadline();
    if (this.#state.phase !== 'question' || !this.#state.currentQuestion) return;
    if (
      this.#state.currentQuestion.timingPhase !== 'answering' ||
      this.#state.currentQuestion.deadlineAt === null
    ) {
      return;
    }
    const questionId =
      this.pack.episode.rounds[this.#state.currentQuestion.roundIndex]?.questions[
        this.#state.currentQuestion.questionIndex
      ]?.id;
    if (!questionId) return;
    const delay = Math.max(0, this.#state.currentQuestion.deadlineAt - this.#now());
    this.#deadlineTimer = setTimeout(() => {
      void this.#revealFromSystem(questionId, 'timer');
    }, delay);
  }

  #scheduleAllAnswered(): void {
    if (this.#state.phase !== 'question' || !this.#state.currentQuestion) return;
    const pointer = this.#state.currentQuestion;
    if (pointer.timingPhase !== 'answering') return;
    if (
      pointer.eligiblePlayerIds.length === 0 ||
      Object.keys(pointer.answers).length !== pointer.eligiblePlayerIds.length
    ) {
      return;
    }
    const questionId =
      this.pack.episode.rounds[pointer.roundIndex]?.questions[pointer.questionIndex]?.id;
    if (!questionId) return;
    this.#clearDeadline();
    this.#deadlineTimer = setTimeout(() => {
      void this.#revealFromSystem(questionId, 'all_answered');
    }, ALL_ANSWERED_REVEAL_DELAY_MS);
  }

  #commit(
    actorId: string,
    commandId: string,
    command: GameCommand,
    credential?: CredentialRecord,
  ): ProtocolAck {
    const cached = this.#store.readCommandResult(this.identity.sessionId, actorId, commandId) as
      ProtocolAck | undefined;
    if (cached) return cached;

    const decision = decideGame({ pack: this.pack }, this.#state, command);
    if (!decision.ok) {
      return {
        ok: false,
        code: 'command_rejected',
        message: decision.message,
        retryable: false,
        currentRevision: this.#state.revision,
      };
    }

    const result: ProtocolAck = { ok: true };
    this.#store.append(this.identity.sessionId, this.#state.revision, decision.events, {
      command: {
        actorId,
        commandId,
        result,
        createdAt: command.now,
      },
      ...(credential === undefined ? {} : { credential }),
    });
    this.#state = applyEvents(this.#state, decision.events);
    this.#publish();

    if (decision.events.some((event) => event.type === 'question.opened')) {
      this.#scheduleDeadline();
    }
    if (
      decision.events.some(
        (event) =>
          event.type === 'question.answers_presented' ||
          event.type === 'question.answer_window_opened',
      )
    ) {
      this.#scheduleDeadline();
    }
    if (decision.events.some((event) => event.type === 'question.revealed')) {
      this.#clearDeadline();
    }

    return result;
  }

  async join(input: PlayerJoin): Promise<ProtocolAck<JoinRuntimeSuccess>> {
    return this.#enqueue(() => {
      const cacheKey = `${input.clientId}:${input.commandId}`;
      const cached = this.#joinResponseCache.get(cacheKey);
      if (cached) return cached;

      if (input.sessionCode !== this.identity.code || !this.verifyJoinSecret(input.joinSecret)) {
        return {
          ok: false,
          code: 'room_not_found',
          message: 'That room code is not active.',
          retryable: true,
        };
      }

      const normalizedName = normalizeDisplayName(input.displayName);
      if (!normalizedName.ok) {
        return {
          ok: false,
          code: 'name_rejected',
          message: normalizedName.message,
          retryable: true,
        };
      }

      const duplicateName = Object.values(this.#state.players).some(
        (player) => player.name.toLocaleLowerCase() === normalizedName.name.toLocaleLowerCase(),
      );
      if (duplicateName) {
        return {
          ok: false,
          code: 'name_rejected',
          message: 'Someone in this room already has that name.',
          retryable: true,
        };
      }

      const playerId = randomUUID();
      const resumeToken = secret();
      const credential: CredentialRecord = {
        playerId,
        clientId: input.clientId,
        tokenHash: digest(resumeToken),
        connectionEpoch: 1,
      };
      const decision = decideGame({ pack: this.pack }, this.#state, {
        type: 'player.join',
        now: this.#now(),
        playerId,
        name: normalizedName.name,
      });

      if (!decision.ok) {
        const rejected: ProtocolAck<JoinRuntimeSuccess> = {
          ok: false,
          code: decision.code === 'game_not_ready' ? 'room_full' : 'command_rejected',
          message: decision.message,
          retryable: false,
          currentRevision: this.#state.revision,
        };
        this.#joinResponseCache.set(cacheKey, rejected);
        return rejected;
      }

      this.#store.append(this.identity.sessionId, this.#state.revision, decision.events, {
        command: {
          actorId: input.clientId,
          commandId: input.commandId,
          result: { ok: true, playerId },
          createdAt: this.#now(),
        },
        credential,
      });
      this.#state = applyEvents(this.#state, decision.events);
      this.#publish();

      const accepted: ProtocolAck<JoinRuntimeSuccess> = {
        ok: true,
        playerId,
        resumeToken,
        connectionEpoch: credential.connectionEpoch,
        snapshot: this.playerSnapshot(playerId),
      };
      this.#joinResponseCache.set(cacheKey, accepted);
      return accepted;
    });
  }

  async resume(input: PlayerResume): Promise<ProtocolAck<JoinRuntimeSuccess>> {
    return this.#enqueue(() => {
      if (input.sessionCode !== this.identity.code) {
        return {
          ok: false,
          code: 'room_not_found',
          message: 'That room code is not active.',
          retryable: true,
        };
      }
      const credential = this.#store.readCredential(this.identity.sessionId, input.playerId);
      if (!credential || !safeHashEqual(credential.tokenHash, input.resumeToken)) {
        return {
          ok: false,
          code: 'unauthorized',
          message: 'This phone no longer owns that player slot.',
          retryable: false,
        };
      }

      const pendingDisconnect = this.#disconnectTimers.get(input.playerId);
      if (pendingDisconnect) {
        clearTimeout(pendingDisconnect);
        this.#disconnectTimers.delete(input.playerId);
      }

      const nextCredential = {
        ...credential,
        connectionEpoch: credential.connectionEpoch + 1,
      };
      const result = this.#commit(
        input.playerId,
        input.commandId,
        {
          type: 'player.connection',
          now: this.#now(),
          playerId: input.playerId,
          connected: true,
        },
        nextCredential,
      );
      if (!result.ok) return result;

      return {
        ok: true,
        playerId: input.playerId,
        resumeToken: input.resumeToken,
        connectionEpoch: nextCredential.connectionEpoch,
        snapshot: this.playerSnapshot(input.playerId),
      };
    });
  }

  async setReady(playerId: string, input: PlayerReady): Promise<ProtocolAck> {
    return this.#enqueue(() =>
      this.#commit(playerId, input.commandId, {
        type: 'player.ready',
        now: this.#now(),
        playerId,
        ready: input.ready,
      }),
    );
  }

  async submitAnswer(playerId: string, input: PlayerAnswer): Promise<ProtocolAck> {
    return this.#enqueue(() => {
      const result = this.#commit(playerId, input.commandId, {
        type: 'player.answer',
        now: this.#now(),
        playerId,
        questionId: input.questionId,
        answerId: input.answerId,
        phaseToken: input.phaseToken,
      });
      if (result.ok) this.#scheduleAllAnswered();
      return result;
    });
  }

  async hostCommand(input: HostCommand): Promise<ProtocolAck> {
    return this.#enqueue(() => {
      if (input.expectedRevision !== this.#state.revision) {
        return {
          ok: false,
          code: 'stale_revision',
          message: 'The show advanced on another host connection. The current state was restored.',
          retryable: true,
          currentRevision: this.#state.revision,
        };
      }

      const now = this.#now();
      const command: GameCommand =
        input.action === 'start'
          ? { type: 'host.start', now }
          : input.action === 'advance'
            ? { type: 'host.advance', now, nextPhaseToken: secret(18) }
            : input.action === 'reveal'
              ? { type: 'host.reveal', now, reason: 'host' }
              : input.action === 'answers_presented' || input.action === 'narration_complete'
                ? {
                    type: 'host.answers_presented',
                    now,
                    questionId: input.questionId,
                  }
                : input.action === 'answer_narration_complete'
                  ? {
                      type: 'host.answer_narration_complete',
                      now,
                      questionId: input.questionId,
                    }
                  : { type: 'host.reset', now };

      return this.#commit('host', input.commandId, command);
    });
  }

  markDisconnected(playerId: string, connectionEpoch: number): void {
    if (!this.verifyConnectionLease(playerId, connectionEpoch)) return;
    const existing = this.#disconnectTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#disconnectTimers.delete(playerId);
      if (!this.verifyConnectionLease(playerId, connectionEpoch)) return;
      void this.#enqueue(() =>
        this.#commit(playerId, `disconnect:${randomUUID()}`, {
          type: 'player.connection',
          now: this.#now(),
          playerId,
          connected: false,
        }),
      );
    }, DISCONNECT_GRACE_MS);
    this.#disconnectTimers.set(playerId, timer);
  }

  async #revealFromSystem(questionId: string, reason: 'timer' | 'all_answered'): Promise<void> {
    await this.#enqueue(() => {
      if (this.#state.phase !== 'question') return;
      const pointer = this.#state.currentQuestion;
      const activeQuestion = pointer
        ? this.pack.episode.rounds[pointer.roundIndex]?.questions[pointer.questionIndex]
        : null;
      if (activeQuestion?.id !== questionId) return;
      this.#commit('system', `reveal:${questionId}`, {
        type: 'host.reveal',
        now: this.#now(),
        reason,
      });
    });
  }

  close(): void {
    this.#clearDeadline();
    for (const timer of this.#disconnectTimers.values()) clearTimeout(timer);
    this.#disconnectTimers.clear();
    if (this.#ownsStore) this.#store.close();
  }
}

export interface JoinRuntimeSuccess {
  playerId: string;
  resumeToken: string;
  connectionEpoch: number;
  snapshot: GameSnapshot;
}
