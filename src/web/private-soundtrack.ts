import { useEffect, useRef, useState } from 'react';

type ShowPhase = 'lobby' | 'intro' | 'question' | 'reveal' | 'finale' | 'complete';

interface TrackListing {
  name: string;
  url: string;
}

interface SoundtrackManifest {
  tracks: TrackListing[];
}

const trackPattern: Record<ShowPhase, RegExp | null> = {
  lobby: /title screen|we're waiting/i,
  intro: /main theme/i,
  question: /question in session/i,
  reveal: /question answered/i,
  finale: /you are so screwed/i,
  complete: /game ending/i,
};

export function usePrivateSoundtrack(
  runtimeOrigin: string,
  hostSecret: string | null,
  phase: ShowPhase | undefined,
  muted: boolean,
): void {
  const tracks = useRef(new Map<string, string>());
  const active = useRef<HTMLAudioElement | null>(null);
  const activePhase = useRef<ShowPhase | null>(null);
  const [libraryRevision, setLibraryRevision] = useState(0);

  useEffect(() => {
    if (!hostSecret) return;
    const controller = new AbortController();
    const objectUrls: string[] = [];
    void (async () => {
      const response = await fetch(`${runtimeOrigin}/api/private-music`, {
        headers: { 'X-YAW-HOST-KEY': hostSecret },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const manifest = (await response.json()) as SoundtrackManifest;
      await Promise.all(
        manifest.tracks.map(async (track) => {
          const audioResponse = await fetch(`${runtimeOrigin}${track.url}`, {
            headers: { 'X-YAW-HOST-KEY': hostSecret },
            signal: controller.signal,
          });
          if (!audioResponse.ok) return;
          const url = URL.createObjectURL(await audioResponse.blob());
          objectUrls.push(url);
          tracks.current.set(track.name, url);
        }),
      );
      if (!controller.signal.aborted) setLibraryRevision((revision) => revision + 1);
    })().catch(() => {
      // The private soundtrack is deliberately optional; the show remains playable without it.
    });
    return () => {
      controller.abort();
      active.current?.pause();
      active.current = null;
      tracks.current.clear();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [hostSecret, runtimeOrigin]);

  useEffect(() => {
    if (!phase || (activePhase.current === phase && active.current)) {
      if (active.current) active.current.muted = muted;
      return;
    }
    activePhase.current = phase;
    const pattern = trackPattern[phase];
    const match = pattern
      ? [...tracks.current.entries()].find(([name]) => pattern.test(name))
      : undefined;
    active.current?.pause();
    active.current = null;
    if (!match) return;
    const audio = new Audio(match[1]);
    audio.loop = phase === 'lobby' || phase === 'question';
    audio.volume = phase === 'question' || phase === 'reveal' ? 0.1 : 0.16;
    audio.muted = muted;
    active.current = audio;
    void audio.play().catch(() => undefined);
  }, [libraryRevision, muted, phase]);
}
