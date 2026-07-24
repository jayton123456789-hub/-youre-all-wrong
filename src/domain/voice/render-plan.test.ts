import { describe, expect, it } from 'vitest';

import { makeTestShowpack } from '../testkit/showpack.js';
import { buildVoiceRenderPlan, type VoiceRendererIdentity } from './render-plan.js';

const renderer: VoiceRendererIdentity = {
  engineId: 'chatterbox-original',
  modelRevision: 'pinned-model-commit',
  voiceProfileHash: 'a'.repeat(64),
  deliveryPresetRevision: 'delivery-v1',
  pronunciationRevision: 'lexicon-v1',
  postProcessingRevision: 'dialogue-v1',
};

describe('buildVoiceRenderPlan', () => {
  it('enumerates every reachable line, including wrong branches and endings', () => {
    const plan = buildVoiceRenderPlan(makeTestShowpack(), renderer);
    const cueIds = plan.map((line) => line.cueId);

    expect(cueIds).toContain('question-one-wrong-b');
    expect(cueIds).toContain('question-one-correct');
    expect(cueIds).toContain('finale-title-drop');
    expect(cueIds).toContain('winner-roast-one');
    expect(cueIds).toContain('loser-roast-one');
    expect(new Set(cueIds).size).toBe(cueIds.length);
  });

  it('invalidates only a changed line when its spoken text changes', () => {
    const original = makeTestShowpack();
    const changed = structuredClone(original);
    const changedCue =
      changed.episode.rounds[0]!.questions[0]!.wrongAnswerReactions['wrong-b']![0]!;
    if (changedCue.type !== 'line') throw new Error('Test fixture must contain a spoken line.');
    changedCue.text += ' Extra damage.';

    const originalPlan = buildVoiceRenderPlan(original, renderer);
    const changedPlan = buildVoiceRenderPlan(changed, renderer);
    const changedIds = originalPlan
      .filter((line, index) => line.cacheKey !== changedPlan[index]?.cacheKey)
      .map((line) => line.cueId);

    expect(changedIds).toEqual(['question-one-wrong-b']);
  });

  it('invalidates the full cache when a model revision changes', () => {
    const pack = makeTestShowpack();
    const first = buildVoiceRenderPlan(pack, renderer);
    const second = buildVoiceRenderPlan(pack, {
      ...renderer,
      modelRevision: 'different-pinned-commit',
    });

    expect(first.every((line, index) => line.cacheKey !== second[index]?.cacheKey)).toBe(true);
  });
});
