import { z } from 'zod';

import { DeliveryStyleSchema } from '../showpack/schema.js';

const HexDigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);

const WorkerEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
  })
  .strict();

export const HelloRequestSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('hello'),
}).strict();

export const CapabilitiesResponseSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('capabilities'),
  workerVersion: z.string().min(1),
  engines: z.array(
    z
      .object({
        id: z.string().min(1),
        modelRevision: z.string().min(1),
        device: z.enum(['cuda', 'cpu']),
        ready: z.boolean(),
        deliveryStyles: z.array(DeliveryStyleSchema),
        supportsVoiceReference: z.boolean(),
        supportsVoiceDesign: z.boolean(),
      })
      .strict(),
  ),
}).strict();

const RenderSegmentSchema = z
  .object({
    text: z.string().trim().min(1).max(3_000),
    pauseAfterMs: z.number().int().min(0).max(10_000),
  })
  .strict();

export const RenderRequestSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('render'),
  jobId: z.string().uuid(),
  cueId: z.string().min(1).max(80),
  engineId: z.string().min(1).max(100),
  modelRevision: z.string().min(1).max(200),
  voiceProfileHash: HexDigestSchema,
  voiceReferencePath: z.string().min(1).max(1_024),
  deliveryPresetRevision: z.string().min(1).max(100),
  delivery: DeliveryStyleSchema,
  energyPermille: z.number().int().min(0).max(1_000),
  pacePermille: z.number().int().min(650).max(1_350),
  seed: z.number().int().min(0).max(2_147_483_647),
  segments: z.array(RenderSegmentSchema).min(1).max(64),
  outputMasterPath: z.string().min(1).max(1_024),
}).strict();

export const CancelRequestSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('cancel'),
  jobId: z.string().uuid(),
}).strict();

export const ShutdownRequestSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('shutdown'),
}).strict();

export const ProgressResponseSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('progress'),
  jobId: z.string().uuid(),
  phase: z.enum(['loading_model', 'conditioning_voice', 'generating', 'quality_check', 'writing']),
  completedPermille: z.number().int().min(0).max(1_000),
}).strict();

export const ResultResponseSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('result'),
  jobId: z.string().uuid(),
  cueId: z.string().min(1).max(80),
  outputMasterPath: z.string().min(1).max(1_024),
  audioSha256: HexDigestSchema,
  sampleRate: z.number().int().min(8_000).max(192_000),
  channels: z.literal(1),
  durationMs: z.number().int().min(1).max(900_000),
  peakDbfs: z.number().max(0),
}).strict();

export const WorkerErrorSchema = WorkerEnvelopeSchema.extend({
  type: z.literal('error'),
  jobId: z.string().uuid().optional(),
  code: z.enum([
    'bad_request',
    'engine_unavailable',
    'model_load_failed',
    'out_of_memory',
    'generation_failed',
    'quality_check_failed',
    'cancelled',
    'internal_error',
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
}).strict();

export const VoiceWorkerRequestSchema = z.discriminatedUnion('type', [
  HelloRequestSchema,
  RenderRequestSchema,
  CancelRequestSchema,
  ShutdownRequestSchema,
]);

export const VoiceWorkerResponseSchema = z.discriminatedUnion('type', [
  CapabilitiesResponseSchema,
  ProgressResponseSchema,
  ResultResponseSchema,
  WorkerErrorSchema,
]);

export type RenderRequest = z.infer<typeof RenderRequestSchema>;
export type VoiceWorkerRequest = z.infer<typeof VoiceWorkerRequestSchema>;
export type VoiceWorkerResponse = z.infer<typeof VoiceWorkerResponseSchema>;
