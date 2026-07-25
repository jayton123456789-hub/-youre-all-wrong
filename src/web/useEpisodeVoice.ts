import { useEffect, useState } from 'react';

import {
  prepareVoiceBank,
  type VoiceBank,
  type VoiceLoadProgress,
  type VoiceLoadPhase,
} from './voice.js';

const INITIAL_PROGRESS: VoiceLoadProgress = {
  phase: 'checking',
  completed: 0,
  total: 0,
  rendered: 0,
  cached: 0,
  voiceName: 'Local host',
  message: 'Connecting to the episode kitchen…',
};

export interface EpisodeVoiceState {
  bank: VoiceBank | null;
  progress: VoiceLoadProgress;
  ready: boolean;
}

export function useEpisodeVoice(
  runtimeOrigin: string,
  hostSecret: string | null,
): EpisodeVoiceState {
  const [bank, setBank] = useState<VoiceBank | null>(null);
  const [progress, setProgress] = useState<VoiceLoadProgress>(INITIAL_PROGRESS);

  useEffect(() => {
    if (!hostSecret) return;
    const controller = new AbortController();
    let loadedBank: VoiceBank | null = null;

    void prepareVoiceBank(runtimeOrigin, hostSecret, controller.signal, setProgress)
      .then((nextBank) => {
        if (controller.signal.aborted) {
          nextBank.dispose();
          return;
        }
        loadedBank = nextBank;
        setBank(nextBank);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const phase: VoiceLoadPhase = 'error';
        setProgress((current) => ({
          ...current,
          phase,
          message: reason instanceof Error ? reason.message : String(reason),
        }));
      });

    return () => {
      controller.abort();
      loadedBank?.dispose();
    };
  }, [hostSecret, runtimeOrigin]);

  return { bank, progress, ready: progress.phase === 'ready' && bank !== null };
}
