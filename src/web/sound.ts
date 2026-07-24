let sharedContext: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    sharedContext ??= new AudioContext();
    return sharedContext;
  } catch {
    return null;
  }
}

function tone(
  audio: AudioContext,
  frequency: number,
  start: number,
  duration: number,
  gain: number,
  type: OscillatorType,
): void {
  const oscillator = audio.createOscillator();
  const envelope = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(50, frequency * 0.82),
    start + duration,
  );
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function playUiSound(kind: 'tap' | 'lock' | 'advance' | 'wrong'): void {
  const audio = context();
  if (!audio) return;
  void audio.resume();
  const now = audio.currentTime + 0.01;

  if (kind === 'tap') {
    tone(audio, 390, now, 0.07, 0.045, 'triangle');
  } else if (kind === 'lock') {
    tone(audio, 520, now, 0.09, 0.05, 'square');
    tone(audio, 780, now + 0.065, 0.12, 0.04, 'triangle');
  } else if (kind === 'advance') {
    tone(audio, 240, now, 0.11, 0.055, 'sawtooth');
    tone(audio, 360, now + 0.07, 0.16, 0.045, 'triangle');
  } else {
    tone(audio, 150, now, 0.2, 0.055, 'sawtooth');
    tone(audio, 92, now + 0.06, 0.25, 0.04, 'square');
  }
}
