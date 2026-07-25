import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical.js';
import { buildPlayerGroupCalloutCues } from '../game/player-callouts.js';
import type { Cue, Showpack } from '../showpack/schema.js';

const PRONUNCIATION_APPLICATION_REVISION = 'whole-token-substitution-v2';

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
  pronunciation: Record<string, string>;
  cacheKey: string;
}

function normalizePronunciation(pronunciation: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pronunciation)
      .map(([written, spoken]) => [
        written.normalize('NFKC'),
        spoken.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
      ])
      .sort(([writtenA], [writtenB]) => writtenA.localeCompare(writtenB)),
  );
}

function lineCacheKey(
  line: Omit<PlannedLine, 'cacheKey'>,
  renderer: VoiceRendererIdentity,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        renderer,
        pronunciationApplicationRevision: PRONUNCIATION_APPLICATION_REVISION,
        spokenText: line.text.normalize('NFKC').replace(/\s+/gu, ' ').trim(),
        cue: {
          delivery: line.delivery,
          pacePermille: line.pacePermille,
          energyPermille: line.energyPermille,
          pauseBeforeMs: line.pauseBeforeMs,
          pauseAfterMs: line.pauseAfterMs,
          pronunciation: line.pronunciation,
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
        ...question.answers.map((answer) => answer.narration),
        question.correctReaction,
        question.noAnswerReaction,
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

  // These short phrases let the reveal director address stable seat numbers
  // without generating names or any speech during the live match.
  sequences.push(buildPlayerGroupCalloutCues(pack.manifest.maxPlayers));
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
        pronunciation: normalizePronunciation(cue.pronunciation),
      };
      plan.push({
        ...withoutKey,
        cacheKey: lineCacheKey(withoutKey, renderer),
      });
    }
  }

  return plan;
}
