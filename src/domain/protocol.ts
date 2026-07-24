import { z } from 'zod';

import type { GameSnapshot } from './game/types.js';

const IdSchema = z.string().min(8).max(128);
const CommandIdSchema = z.string().uuid();
const SessionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{5}$/);

export const PlayerJoinSchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: CommandIdSchema,
    sessionCode: SessionCodeSchema,
    joinSecret: z.string().min(20).max(200).optional(),
    clientId: IdSchema,
    displayName: z.string().trim().min(1).max(32),
  })
  .strict();

export const PlayerResumeSchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: CommandIdSchema,
    sessionCode: SessionCodeSchema,
    playerId: IdSchema,
    resumeToken: z.string().min(32).max(256),
  })
  .strict();

export const PlayerReadySchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: CommandIdSchema,
    ready: z.boolean(),
  })
  .strict();

export const PlayerAnswerSchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: CommandIdSchema,
    expectedRevision: z.number().int().min(1),
    questionId: z.string().min(1).max(80),
    answerId: z.string().min(1).max(80),
    phaseToken: z.string().min(20).max(200),
  })
  .strict();

export const HostAttachSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionId: IdSchema,
    hostSecret: z.string().min(32).max(256),
  })
  .strict();

export const HostCommandSchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: CommandIdSchema,
    expectedRevision: z.number().int().min(1),
    action: z.enum(['start', 'advance', 'reveal', 'reset']),
  })
  .strict();

export type PlayerJoin = z.infer<typeof PlayerJoinSchema>;
export type PlayerResume = z.infer<typeof PlayerResumeSchema>;
export type PlayerReady = z.infer<typeof PlayerReadySchema>;
export type PlayerAnswer = z.infer<typeof PlayerAnswerSchema>;
export type HostAttach = z.infer<typeof HostAttachSchema>;
export type HostCommand = z.infer<typeof HostCommandSchema>;

export type ProtocolErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'room_not_found'
  | 'room_full'
  | 'name_rejected'
  | 'stale_revision'
  | 'command_rejected'
  | 'rate_limited'
  | 'internal_error';

export type ProtocolAck<T = object> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: ProtocolErrorCode;
      message: string;
      retryable: boolean;
      currentRevision?: number;
    };

export interface JoinSuccess {
  playerId: string;
  resumeToken: string;
  connectionEpoch: number;
  snapshot: GameSnapshot;
}

export interface AttachSuccess {
  snapshot: GameSnapshot;
  joinUrls: string[];
}

export interface StatePush {
  sequence: number;
  snapshot: GameSnapshot;
}

export type AckCallback<T = object> = (ack: ProtocolAck<T>) => void;

export interface ClientToServerEvents {
  'host:attach': (payload: unknown, acknowledge: AckCallback<AttachSuccess>) => void;
  'host:command': (payload: unknown, acknowledge: AckCallback) => void;
  'player:join': (payload: unknown, acknowledge: AckCallback<JoinSuccess>) => void;
  'player:resume': (payload: unknown, acknowledge: AckCallback<JoinSuccess>) => void;
  'player:ready': (payload: unknown, acknowledge: AckCallback) => void;
  'player:answer': (payload: unknown, acknowledge: AckCallback) => void;
}

export interface ServerToClientEvents {
  state: (payload: StatePush) => void;
  'session:replaced': (payload: { message: string }) => void;
}
