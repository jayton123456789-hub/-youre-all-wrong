import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { VoiceRendererConfig } from './voice-preflight.js';

export interface ChatterboxRendererOptions {
  model: string;
  modelRevision: string;
  voiceName: string;
  voiceId?: string | undefined;
  referencePath?: string | undefined;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createChatterboxRendererConfig(
  options: ChatterboxRendererOptions,
): Promise<VoiceRendererConfig> {
  const modelRevision = options.modelRevision.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(modelRevision)) {
    throw new Error('Chatterbox requires an exact 40-character model repository revision.');
  }
  const referencePath = options.referencePath?.trim();
  const referenceContentHash = referencePath
    ? sha256(await readFile(resolve(referencePath)))
    : 'no-reference';

  return {
    engineId: 'chatterbox-tts',
    modelRevision: `chatterbox-${options.model}@${modelRevision}-pip-0.1.7`,
    deliveryPresetRevision: 'yaw-chatterbox-delivery-v2',
    pronunciationRevision: 'whole-token-substitution-v2',
    postProcessingRevision: 'librosa-tempo-v1',
    voiceName: options.voiceName,
    voiceProfileHashSource: [
      options.model,
      modelRevision,
      options.voiceId?.trim() ?? '',
      referenceContentHash,
    ].join(':'),
  };
}
