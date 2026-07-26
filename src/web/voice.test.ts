import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CueSequence } from '../domain/showpack/schema.js';
import type { VoiceAssetManifest } from '../domain/voice/preflight.js';
import {
  prepareVoiceBank,
  VoiceBank,
  type LoadedShowpackAudioAsset,
  type VoiceLoadProgress,
} from './voice.js';

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  static endImmediately = false;

  readonly src: string;
  preload = '';
  volume = 1;
  muted = false;
  loop = false;
  currentTime = 0;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;

  constructor(src = '') {
    super();
    this.src = src;
    FakeAudio.instances.push(this);
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    if (FakeAudio.endImmediately && !this.loop) {
      queueMicrotask(() => this.dispatchEvent(new Event('ended')));
    }
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

const voiceManifest: VoiceAssetManifest = {
  protocolVersion: 1,
  engineId: 'windows-system-speech',
  voiceName: 'Test Host',
  assets: [],
};

function soundBank(): VoiceBank {
  const loaded: LoadedShowpackAudioAsset = {
    manifest: {
      id: 'sting',
      kind: 'audio',
      bytes: 4,
      sha256: 'a'.repeat(64),
    },
    objectUrl: 'blob:showpack-sting',
  };
  return new VoiceBank(voiceManifest, new Map(), new Map([['sting', loaded]]));
}

function soundCue(
  action: 'play' | 'duck' | 'stop',
  overrides: Partial<Extract<CueSequence[number], { type: 'sound' }>> = {},
): Extract<CueSequence[number], { type: 'sound' }> {
  return {
    type: 'sound',
    id: `sound-${action}`,
    assetId: 'sting',
    action,
    gainDb: 0,
    fadeMs: 0,
    loop: false,
    ...overrides,
  };
}

beforeEach(() => {
  FakeAudio.instances = [];
  FakeAudio.endImmediately = false;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('showpack sound director', () => {
  it('plays a non-looping sound at authored dB gain and waits for its ending', async () => {
    const bank = soundBank();
    let completed = false;
    const playback = bank.playSequence([soundCue('play', { gainDb: -6 })]).then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    const audio = FakeAudio.instances[0]!;
    expect(audio.volume).toBeCloseTo(10 ** (-6 / 20), 5);
    expect(audio.loop).toBe(false);
    expect(completed).toBe(false);

    audio.dispatchEvent(new Event('ended'));
    await playback;
    expect(completed).toBe(true);
  });

  it('keeps loops alive across sequences and obeys duck and stop cues', async () => {
    const bank = soundBank();
    await bank.playSequence([soundCue('play', { gainDb: -6, loop: true })]);
    const audio = FakeAudio.instances[0]!;

    expect(audio.loop).toBe(true);
    expect(audio.paused).toBe(false);
    await bank.playSequence([soundCue('duck', { gainDb: -20 })]);
    expect(audio.volume).toBeCloseTo(0.1, 5);

    await bank.playSequence([soundCue('stop')]);
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
  });

  it('stops an in-flight one-shot and rejects with AbortError when cancelled', async () => {
    const bank = soundBank();
    const controller = new AbortController();
    const playback = bank.playSequence([soundCue('play')], { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(playback).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeAudio.instances[0]?.paused).toBe(true);
  });

  it('fails loudly when an authored sound was not preloaded', async () => {
    const bank = new VoiceBank(voiceManifest, new Map());

    await expect(bank.playSequence([soundCue('play')])).rejects.toThrow(
      'Showpack sound asset "sting" is missing',
    );
  });

  it('surfaces media decode errors instead of silently continuing the show', async () => {
    const bank = soundBank();
    const playback = bank.playSequence([soundCue('play')]);
    await Promise.resolve();
    FakeAudio.instances[0]!.dispatchEvent(new Event('error'));

    await expect(playback).rejects.toThrow('Showpack sound "sting" could not be played');
  });
});

describe('showpack sound preloading', () => {
  it('uses the host secret only as a request header and locks readiness on show audio', async () => {
    const secret = 'private-host-secret';
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/voice/status')) {
        return Response.json({
          state: 'ready',
          completed: 0,
          total: 0,
          rendered: 0,
          cached: 0,
          voiceName: 'Test Host',
          message: 'Ready.',
        });
      }
      if (url.endsWith('/api/voice/manifest')) {
        return Response.json(voiceManifest);
      }
      if (url.endsWith('/api/showpack/assets')) {
        return Response.json({
          assets: [
            {
              id: 'sting',
              kind: 'audio',
              bytes: 4,
              sha256: 'a'.repeat(64),
            },
          ],
        });
      }
      if (url.endsWith('/api/showpack/assets/sting')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:loaded-sting');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const progress: VoiceLoadProgress[] = [];

    const bank = await prepareVoiceBank(
      'http://127.0.0.1:4310',
      secret,
      new AbortController().signal,
      (next) => progress.push(next),
    );

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toMatchObject({ phase: 'ready', completed: 1, total: 1 });
    expect(calls.every(({ url }) => !url.includes(secret))).toBe(true);
    expect(
      calls.every(
        ({ init }) =>
          (init?.headers as Record<string, string> | undefined)?.['X-YAW-HOST-KEY'] === secret,
      ),
    ).toBe(true);
    bank.dispose();
  });
});
