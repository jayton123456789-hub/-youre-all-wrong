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
  it('enumerates every reachable line, endings, and numbered player-group callouts', () => {
    const plan = buildVoiceRenderPlan(makeTestShowpack(), renderer);
    const cueIds = plan.map((line) => line.cueId);

    expect(cueIds).toContain('question-one-wrong-b');
    expect(cueIds).toContain('question-one-correct');
    expect(cueIds).toContain('finale-title-drop');
    expect(cueIds).toContain('winner-roast-one');
    expect(cueIds).toContain('loser-roast-one');
    expect(cueIds).toContain('runtime-player-callout-1');
    expect(cueIds).toContain('runtime-player-callout-1-2');
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

  it('normalizes pronunciation hints and invalidates only the affected clip', () => {
    const original = makeTestShowpack();
    const changed = structuredClone(original);
    const originalCue = original.episode.rounds[0]!.questions[0]!.prompt[0]!;
    const changedCue = changed.episode.rounds[0]!.questions[0]!.prompt[0]!;
    if (originalCue.type !== 'line' || changedCue.type !== 'line') {
      throw new Error('Test fixture must contain a spoken prompt line.');
    }
    originalCue.pronunciation = { GIF: 'jiff' };
    changedCue.pronunciation = { GIF: 'gee eye eff' };

    const originalPlan = buildVoiceRenderPlan(original, renderer);
    const changedPlan = buildVoiceRenderPlan(changed, renderer);
    const originalPrompt = originalPlan.find((line) => line.cueId === originalCue.id);
    const changedPrompt = changedPlan.find((line) => line.cueId === changedCue.id);

    expect(originalPrompt?.pronunciation).toEqual({ GIF: 'jiff' });
    expect(changedPrompt?.pronunciation).toEqual({ GIF: 'gee eye eff' });
    expect(changedPrompt?.cacheKey).not.toBe(originalPrompt?.cacheKey);
    expect(
      originalPlan
        .filter((line, index) => line.cacheKey !== changedPlan[index]?.cacheKey)
        .map((line) => line.cueId),
    ).toEqual([originalCue.id]);
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
