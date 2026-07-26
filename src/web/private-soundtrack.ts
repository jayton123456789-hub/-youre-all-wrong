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
  finale: /ending tunes|you are so screwed/i,
  complete: /ending tunes|game ending/i,
};

interface SynthLoop {
  context: AudioContext;
  nodes: AudioNode[];
  timers: number[];
}

function startSynthLoop(phase: ShowPhase, muted: boolean): SynthLoop | null {
  if (muted) return null;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  const output = context.createGain();
  output.gain.value = phase === 'question' || phase === 'reveal' ? 0.035 : 0.055;
  output.connect(context.destination);
  void context.resume();

  const timers: number[] = [];
  const nodes: AudioNode[] = [output];
  const scale =
    phase === 'lobby' || phase === 'complete' ? [110, 165, 220, 277] : [82, 123, 165, 247];
  let step = 0;

  const schedule = () => {
    if (context.state === 'closed') return;
    const now = context.currentTime + 0.02;
    const frequency = scale[step % scale.length]!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = step % 4 === 0 ? 'sawtooth' : 'triangle';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.5, now + 0.18);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.75, now + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    oscillator.connect(envelope).connect(output);
    oscillator.start(now);
    oscillator.stop(now + 0.38);
    step += 1;
  };

  schedule();
  timers.push(window.setInterval(schedule, phase === 'question' ? 360 : 520));
  return { context, nodes, timers };
}

function stopSynthLoop(loop: SynthLoop | null): void {
  if (!loop) return;
  loop.timers.forEach((timer) => window.clearInterval(timer));
  loop.nodes.forEach((node) => node.disconnect());
  void loop.context.close().catch(() => undefined);
}

export function usePrivateSoundtrack(
  runtimeOrigin: string,
  hostSecret: string | null,
  phase: ShowPhase | undefined,
  muted: boolean,
): void {
  const tracks = useRef(new Map<string, string>());
  const active = useRef<HTMLAudioElement | null>(null);
  const activePhase = useRef<ShowPhase | null>(null);
  const synth = useRef<SynthLoop | null>(null);
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
      stopSynthLoop(synth.current);
      synth.current = null;
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
    stopSynthLoop(synth.current);
    synth.current = null;
    if (!match) {
      synth.current = startSynthLoop(phase, muted);
      return;
    }
    const audio = new Audio(match[1]);
    audio.loop = phase === 'lobby' || phase === 'question';
    audio.volume = phase === 'question' || phase === 'reveal' ? 0.1 : 0.16;
    audio.muted = muted;
    active.current = audio;
    void audio.play().catch(() => undefined);
  }, [libraryRevision, muted, phase]);

  useEffect(() => {
    if (muted) {
      stopSynthLoop(synth.current);
      synth.current = null;
    }
  }, [muted]);
}
