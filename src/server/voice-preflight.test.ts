import { describe, expect, it } from 'vitest';

import { waveDurationMs } from './voice-preflight.js';

function pcmWave(durationMs: number, byteRate = 16_000): Buffer {
  const dataBytes = Math.round((durationMs / 1_000) * byteRate);
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write('RIFF', 0, 'ascii');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVE', 8, 'ascii');
  wave.write('fmt ', 12, 'ascii');
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16_000, 24);
  wave.writeUInt32LE(byteRate, 28);
  wave.writeUInt16LE(1, 32);
  wave.writeUInt16LE(8, 34);
  wave.write('data', 36, 'ascii');
  wave.writeUInt32LE(dataBytes, 40);
  return wave;
}

describe('voice preflight', () => {
  it('derives exact clip timing from PCM wave metadata', () => {
    expect(waveDurationMs(pcmWave(1_375))).toBe(1_375);
  });

  it('rejects corrupt cache entries instead of guessing their duration', () => {
    expect(() => waveDurationMs(Buffer.from('not audio'))).toThrow(/RIFF\/WAVE/u);
  });
});
