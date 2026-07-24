import { z } from 'zod';

const IdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.includes('\\'), 'Asset paths must use forward slashes.')
  .refine((value) => !value.startsWith('/'), 'Asset paths must be relative.')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '..' && segment !== '.'),
    'Asset paths may not traverse directories.',
  );

export const DeliveryStyleSchema = z.enum([
  'conversational',
  'dry',
  'smug',
  'mock_sincere',
  'conspiratorial',
  'announcer',
  'excited',
  'disappointed',
  'furious',
  'finale_shout',
]);

const LineCueSchema = z
  .object({
    type: z.literal('line'),
    id: IdSchema,
    speaker: IdSchema.default('host'),
    text: z.string().trim().min(1).max(3_000),
    delivery: DeliveryStyleSchema.default('conversational'),
    pace: z.number().min(0.65).max(1.35).default(1),
    energy: z.number().min(0).max(1).default(0.55),
    pauseBeforeMs: z.number().int().min(0).max(10_000).default(0),
    pauseAfterMs: z.number().int().min(0).max(10_000).default(250),
    pronunciation: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .strict();

const StageCueSchema = z
  .object({
    type: z.literal('stage'),
    id: IdSchema,
    action: z.enum([
      'category_in',
      'category_out',
      'question_in',
      'answers_in',
      'scoreboard_in',
      'scoreboard_out',
      'blackout',
      'logo_slam',
      'lights_shift',
      'confetti',
      'screen_shake',
    ]),
    intensity: z.number().min(0).max(1).default(0.6),
    durationMs: z.number().int().min(0).max(30_000).default(600),
  })
  .strict();

const SoundCueSchema = z
  .object({
    type: z.literal('sound'),
    id: IdSchema,
    assetId: IdSchema,
    action: z.enum(['play', 'stop', 'duck']),
    gainDb: z.number().min(-60).max(12).default(0),
    fadeMs: z.number().int().min(0).max(30_000).default(0),
  })
  .strict();

const PauseCueSchema = z
  .object({
    type: z.literal('pause'),
    id: IdSchema,
    durationMs: z.number().int().min(25).max(30_000),
  })
  .strict();

const FlagCueSchema = z
  .object({
    type: z.literal('flag'),
    id: IdSchema,
    flag: IdSchema,
    value: z.boolean().default(true),
  })
  .strict();

export const CueSchema = z.discriminatedUnion('type', [
  LineCueSchema,
  StageCueSchema,
  SoundCueSchema,
  PauseCueSchema,
  FlagCueSchema,
]);

export const CueSequenceSchema = z.array(CueSchema).max(96);

const AnswerSchema = z
  .object({
    id: IdSchema,
    text: z.string().trim().min(1).max(240),
    shortLabel: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

export const ReactionConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('unanimous_answer'),
      answerId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('all_correct'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('solo_correct'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fast_answer'),
      answerId: IdSchema,
      withinMs: z.number().int().min(250).max(30_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('streak_broken'),
      minimumStreak: z.number().int().min(2).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal('callback_flag'),
      flag: IdSchema,
      value: z.boolean().default(true),
    })
    .strict(),
]);

const ConditionalReactionSchema = z
  .object({
    id: IdSchema,
    priority: z.number().int().min(0).max(1_000).default(100),
    when: ReactionConditionSchema,
    cues: CueSequenceSchema.min(1),
  })
  .strict();

const ScoringSchema = z
  .object({
    correct: z.number().int().min(0).max(1_000_000).default(1_000),
    speedBonus: z.number().int().min(0).max(1_000_000).default(500),
    wrongPenalty: z.number().int().min(0).max(1_000_000).default(250),
    noAnswerPenalty: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export const QuestionSchema = z
  .object({
    id: IdSchema,
    category: z.string().trim().min(1).max(120),
    categoryIntro: CueSequenceSchema.default([]),
    prompt: CueSequenceSchema.min(1),
    promptText: z.string().trim().min(1).max(3_000),
    answers: z.array(AnswerSchema).min(2).max(6),
    correctAnswerId: IdSchema,
    wrongAnswerReactions: z.record(IdSchema, CueSequenceSchema.min(1)),
    correctReaction: CueSequenceSchema.min(1),
    explanation: CueSequenceSchema.default([]),
    postQuestion: CueSequenceSchema.default([]),
    conditionalReactions: z.array(ConditionalReactionSchema).max(16).default([]),
    timeLimitMs: z.number().int().min(3_000).max(120_000).default(20_000),
    scoring: ScoringSchema.default({
      correct: 1_000,
      speedBonus: 500,
      wrongPenalty: 250,
      noAnswerPenalty: 0,
    }),
    sourceIds: z.array(IdSchema).max(12).default([]),
  })
  .strict();

const StandardRoundSchema = z
  .object({
    type: z.literal('standard'),
    id: IdSchema,
    title: z.string().trim().min(1).max(120),
    intro: CueSequenceSchema.default([]),
    questions: z.array(QuestionSchema).min(1).max(30),
    outro: CueSequenceSchema.default([]),
  })
  .strict();

const FinaleSchema = z
  .object({
    id: IdSchema,
    calmLeadIn: CueSequenceSchema.min(1),
    titleDrop: CueSequenceSchema.min(1),
    outro: CueSequenceSchema.default([]),
    winnerRoasts: z.array(CueSequenceSchema.min(1)).min(1).max(12),
    loserRoasts: z.array(CueSequenceSchema.min(1)).min(1).max(12),
  })
  .strict();

const SourceSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1).max(240),
    url: z.string().url().max(2_000),
    publisher: z.string().trim().min(1).max(160),
    accessedOn: z.string().date(),
  })
  .strict();

const EpisodeSchema = z
  .object({
    id: IdSchema,
    title: z.string().trim().min(1).max(160),
    episodeNumber: z.number().int().min(0).max(99_999).optional(),
    opening: CueSequenceSchema.min(1),
    rounds: z.array(StandardRoundSchema).min(1).max(12),
    finale: FinaleSchema,
    sources: z.array(SourceSchema).max(200).default([]),
  })
  .strict();

const AssetSchema = z
  .object({
    id: IdSchema,
    path: SafeRelativePathSchema,
    kind: z.enum(['audio', 'image', 'font', 'video']),
    sha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(200_000_000),
    license: z.string().trim().min(1).max(200),
    attribution: z.string().trim().max(500).default(''),
  })
  .strict();

const ManifestSchema = z
  .object({
    format: z.literal('games.youreallwrong.showpack'),
    formatVersion: z.literal(1),
    id: IdSchema,
    title: z.string().trim().min(1).max(160),
    author: z.string().trim().min(1).max(120),
    language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    createdAt: z.string().datetime({ offset: true }),
    contentRating: z.enum(['everyone', 'teen', 'mature']),
    minPlayers: z.number().int().min(1).max(32),
    maxPlayers: z.number().int().min(1).max(32),
    estimatedMinutes: z.number().int().min(1).max(240),
    assets: z.array(AssetSchema).max(1_000).default([]),
  })
  .strict();

export const ShowpackSchema = z
  .object({
    manifest: ManifestSchema,
    episode: EpisodeSchema,
  })
  .strict();

export type Cue = z.infer<typeof CueSchema>;
export type CueSequence = z.infer<typeof CueSequenceSchema>;
export type DeliveryStyle = z.infer<typeof DeliveryStyleSchema>;
export type ReactionCondition = z.infer<typeof ReactionConditionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Showpack = z.infer<typeof ShowpackSchema>;
