import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical.js';
import { type Showpack, ShowpackSchema } from './schema.js';

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | {
      ok: true;
      pack: Showpack;
      packHash: string;
      warnings: ValidationIssue[];
    }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

function jsonPointer(path: PropertyKey[]): string {
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function semanticIssues(pack: Showpack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const globalIds = new Map<string, string>();
  const sourceIds = new Set(pack.episode.sources.map((source) => source.id));
  const assetIds = new Set(pack.manifest.assets.map((asset) => asset.id));

  const claimId = (id: string, path: string) => {
    const previousPath = globalIds.get(id);
    if (previousPath) {
      issues.push({
        path,
        code: 'duplicate_id',
        message: `ID "${id}" is already used at ${previousPath}.`,
      });
      return;
    }
    globalIds.set(id, path);
  };

  if (pack.manifest.id !== pack.episode.id) {
    issues.push({
      path: '/episode/id',
      code: 'episode_id_mismatch',
      message: 'Episode ID must match the manifest ID.',
    });
  }

  if (pack.manifest.minPlayers > pack.manifest.maxPlayers) {
    issues.push({
      path: '/manifest/minPlayers',
      code: 'invalid_player_range',
      message: 'minPlayers cannot exceed maxPlayers.',
    });
  }

  claimId(pack.episode.id, '/episode/id');

  pack.manifest.assets.forEach((asset, index) => {
    claimId(asset.id, `/manifest/assets/${index}/id`);
  });

  const inspectCues = (cues: Showpack['episode']['opening'], basePath: string) => {
    cues.forEach((cue, index) => {
      const path = `${basePath}/${index}`;
      if (cue.id.startsWith('runtime-')) {
        issues.push({
          path: `${path}/id`,
          code: 'reserved_runtime_id',
          message: 'Cue IDs beginning with "runtime-" are reserved for generated game assets.',
        });
      }
      claimId(cue.id, `${path}/id`);
      if (cue.type === 'sound' && !assetIds.has(cue.assetId)) {
        issues.push({
          path: `${path}/assetId`,
          code: 'unknown_asset',
          message: `Sound cue references undeclared asset "${cue.assetId}".`,
        });
      }
    });
  };

  inspectCues(pack.episode.opening, '/episode/opening');

  pack.episode.rounds.forEach((round, roundIndex) => {
    const roundPath = `/episode/rounds/${roundIndex}`;
    claimId(round.id, `${roundPath}/id`);
    inspectCues(round.intro, `${roundPath}/intro`);
    inspectCues(round.outro, `${roundPath}/outro`);

    round.questions.forEach((question, questionIndex) => {
      const questionPath = `${roundPath}/questions/${questionIndex}`;
      claimId(question.id, `${questionPath}/id`);

      const answerIds = new Set<string>();
      question.answers.forEach((answer, answerIndex) => {
        if (answerIds.has(answer.id)) {
          issues.push({
            path: `${questionPath}/answers/${answerIndex}/id`,
            code: 'duplicate_answer_id',
            message: `Answer ID "${answer.id}" is duplicated in this question.`,
          });
        }
        answerIds.add(answer.id);
      });

      if (!answerIds.has(question.correctAnswerId)) {
        issues.push({
          path: `${questionPath}/correctAnswerId`,
          code: 'unknown_correct_answer',
          message: 'correctAnswerId must reference one of the question answers.',
        });
      }

      const requiredWrongIds = question.answers
        .filter((answer) => answer.id !== question.correctAnswerId)
        .map((answer) => answer.id);
      const reactionIds = Object.keys(question.wrongAnswerReactions);

      requiredWrongIds.forEach((answerId) => {
        if (!(answerId in question.wrongAnswerReactions)) {
          issues.push({
            path: `${questionPath}/wrongAnswerReactions`,
            code: 'missing_wrong_reaction',
            message: `Wrong answer "${answerId}" needs a self-contained reaction.`,
          });
        }
      });

      reactionIds.forEach((answerId) => {
        if (!answerIds.has(answerId) || answerId === question.correctAnswerId) {
          issues.push({
            path: `${questionPath}/wrongAnswerReactions/${answerId}`,
            code: 'orphan_wrong_reaction',
            message: `Reaction key "${answerId}" is not a wrong answer in this question.`,
          });
        }
      });

      question.sourceIds.forEach((sourceId, sourceIndex) => {
        if (!sourceIds.has(sourceId)) {
          issues.push({
            path: `${questionPath}/sourceIds/${sourceIndex}`,
            code: 'unknown_source',
            message: `Question references unknown source "${sourceId}".`,
          });
        }
      });

      inspectCues(question.categoryIntro, `${questionPath}/categoryIntro`);
      inspectCues(question.prompt, `${questionPath}/prompt`);
      question.answers.forEach((answer, answerIndex) => {
        inspectCues(answer.narration, `${questionPath}/answers/${answerIndex}/narration`);
      });
      inspectCues(question.correctReaction, `${questionPath}/correctReaction`);
      inspectCues(question.noAnswerReaction, `${questionPath}/noAnswerReaction`);
      inspectCues(question.explanation, `${questionPath}/explanation`);
      inspectCues(question.postQuestion, `${questionPath}/postQuestion`);

      Object.entries(question.wrongAnswerReactions).forEach(([answerId, cues]) => {
        inspectCues(cues, `${questionPath}/wrongAnswerReactions/${answerId}`);
      });

      question.conditionalReactions.forEach((reaction, reactionIndex) => {
        claimId(reaction.id, `${questionPath}/conditionalReactions/${reactionIndex}/id`);
        inspectCues(reaction.cues, `${questionPath}/conditionalReactions/${reactionIndex}/cues`);
        if (
          'answerId' in reaction.when &&
          reaction.when.answerId !== undefined &&
          !answerIds.has(reaction.when.answerId)
        ) {
          issues.push({
            path: `${questionPath}/conditionalReactions/${reactionIndex}/when/answerId`,
            code: 'unknown_conditional_answer',
            message: `Conditional reaction references unknown answer "${reaction.when.answerId}".`,
          });
        }
      });
    });
  });

  claimId(pack.episode.finale.id, '/episode/finale/id');
  inspectCues(pack.episode.finale.calmLeadIn, '/episode/finale/calmLeadIn');
  inspectCues(pack.episode.finale.titleDrop, '/episode/finale/titleDrop');
  inspectCues(pack.episode.finale.outro, '/episode/finale/outro');
  pack.episode.finale.winnerRoasts.forEach((cues, index) => {
    inspectCues(cues, `/episode/finale/winnerRoasts/${index}`);
  });
  pack.episode.finale.loserRoasts.forEach((cues, index) => {
    inspectCues(cues, `/episode/finale/loserRoasts/${index}`);
  });

  return issues;
}

export function validateShowpack(input: unknown): ValidationResult {
  const parsed = ShowpackSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: jsonPointer(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    pack: parsed.data,
    packHash: createHash('sha256').update(canonicalJson(parsed.data)).digest('hex'),
    warnings: [],
  };
}
