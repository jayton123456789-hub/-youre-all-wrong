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
  it('enumerates every reachable line, endings, and reusable player callouts', () => {
    const pack = makeTestShowpack();
    pack.episode.rounds[0]!.questions[0]!.questionLeadIn = [
      {
        type: 'line',
        id: 'question-one-number',
        speaker: 'host',
        text: 'Question one.',
        delivery: 'announcer',
        pace: 1,
        energy: 0.7,
        pauseBeforeMs: 0,
        pauseAfterMs: 250,
        pronunciation: {},
      },
    ];
    const plan = buildVoiceRenderPlan(pack, renderer);
    const cueIds = plan.map((line) => line.cueId);

    expect(cueIds).toContain('question-one-number');
    expect(cueIds).toContain('question-one-wrong-b');
    expect(cueIds).toContain('question-one-correct');
    expect(cueIds).toContain('finale-title-drop');
    expect(cueIds).toContain('winner-roast-one');
    expect(cueIds).toContain('loser-roast-one');
    expect(cueIds).toContain('runtime-player-callout-1');
    expect(cueIds).toContain('runtime-player-callout-8');
    expect(cueIds).not.toContain('runtime-player-callout-1-2');
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

  it('renders spokenText while leaving display text out of the voice cache identity', () => {
    const original = makeTestShowpack();
    const changedDisplay = structuredClone(original);
    const changedSpeech = structuredClone(original);
    const originalCue = original.episode.rounds[0]!.questions[0]!.categoryIntro;
    const displayCue = changedDisplay.episode.rounds[0]!.questions[0]!.categoryIntro;
    const speechCue = changedSpeech.episode.rounds[0]!.questions[0]!.categoryIntro;
    originalCue.push({
      type: 'line',
      id: 'spoken-category',
      speaker: 'host',
      text: 'MINECRAFT: THE HEAVY UPDATE',
      spokenText: 'And now, Minecraft: The Heavy Update.',
      delivery: 'announcer',
      pace: 1,
      energy: 0.7,
      pauseBeforeMs: 0,
      pauseAfterMs: 250,
      pronunciation: {},
    });
    const originalLineCue = originalCue.at(-1)!;
    if (originalLineCue.type !== 'line') throw new Error('Expected the appended category line.');
    displayCue.push({
      ...originalLineCue,
      text: 'MINECRAFT: HEAVIER THAN BEFORE',
    });
    speechCue.push({
      ...originalLineCue,
      spokenText: 'Coming up, Minecraft: The Heavy Update.',
    });

    const originalLine = buildVoiceRenderPlan(original, renderer).find(
      (line) => line.cueId === 'spoken-category',
    );
    const displayLine = buildVoiceRenderPlan(changedDisplay, renderer).find(
      (line) => line.cueId === 'spoken-category',
    );
    const speechLine = buildVoiceRenderPlan(changedSpeech, renderer).find(
      (line) => line.cueId === 'spoken-category',
    );

    expect(originalLine?.text).toBe('And now, Minecraft: The Heavy Update.');
    expect(displayLine?.cacheKey).toBe(originalLine?.cacheKey);
    expect(speechLine?.cacheKey).not.toBe(originalLine?.cacheKey);
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
