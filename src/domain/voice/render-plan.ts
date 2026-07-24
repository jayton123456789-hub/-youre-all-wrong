import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical.js';
import type { Cue, Showpack } from '../showpack/schema.js';

export interface VoiceRendererIdentity {
  engineId: string;
  modelRevision: string;
  voiceProfileHash: string;
  deliveryPresetRevision: string;
  pronunciationRevision: string;
  postProcessingRevision: string;
}

export interface PlannedLine {
  cueId: string;
  text: string;
  delivery: Extract<Cue, { type: 'line' }>['delivery'];
  pacePermille: number;
  energyPermille: number;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  cacheKey: string;
}

function lineCacheKey(
  line: Omit<PlannedLine, 'cacheKey'>,
  renderer: VoiceRendererIdentity,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        renderer,
        spokenText: line.text.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
        cue: {
          delivery: line.delivery,
          pacePermille: line.pacePermille,
          energyPermille: line.energyPermille,
          pauseBeforeMs: line.pauseBeforeMs,
          pauseAfterMs: line.pauseAfterMs,
        },
      }),
    )
    .digest('hex');
}

function collectSequences(pack: Showpack): Cue[][] {
  const sequences: Cue[][] = [pack.episode.opening];
  for (const round of pack.episode.rounds) {
    sequences.push(round.intro, round.outro);
    for (const question of round.questions) {
      sequences.push(
        question.categoryIntro,
        question.prompt,
        question.correctReaction,
        question.explanation,
        question.postQuestion,
        ...Object.values(question.wrongAnswerReactions),
        ...question.conditionalReactions.map((reaction) => reaction.cues),
      );
    }
  }
  sequences.push(
    pack.episode.finale.calmLeadIn,
    pack.episode.finale.titleDrop,
    pack.episode.finale.outro,
    ...pack.episode.finale.winnerRoasts,
    ...pack.episode.finale.loserRoasts,
  );
  return sequences;
}

export function buildVoiceRenderPlan(
  pack: Showpack,
  renderer: VoiceRendererIdentity,
): PlannedLine[] {
  const seen = new Set<string>();
  const plan: PlannedLine[] = [];

  for (const sequence of collectSequences(pack)) {
    for (const cue of sequence) {
      if (cue.type !== 'line') continue;
      if (seen.has(cue.id)) {
        throw new Error(`Voice plan encountered duplicate cue ID "${cue.id}".`);
      }
      seen.add(cue.id);

      const withoutKey: Omit<PlannedLine, 'cacheKey'> = {
        cueId: cue.id,
        text: cue.text,
        delivery: cue.delivery,
        pacePermille: Math.round(cue.pace * 1_000),
        energyPermille: Math.round(cue.energy * 1_000),
        pauseBeforeMs: cue.pauseBeforeMs,
        pauseAfterMs: cue.pauseAfterMs,
      };
      plan.push({
        ...withoutKey,
        cacheKey: lineCacheKey(withoutKey, renderer),
      });
    }
  }

  return plan;
}
