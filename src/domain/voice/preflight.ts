import type { DeliveryStyle } from '../showpack/schema.js';

export type VoicePreflightState = 'preparing' | 'ready' | 'error';

export interface VoicePreflightStatus {
  state: VoicePreflightState;
  completed: number;
  total: number;
  rendered: number;
  cached: number;
  voiceName: string;
  message: string;
}

export interface VoiceAssetManifestEntry {
  cueId: string;
  durationMs: number;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  delivery: DeliveryStyle;
}

export interface VoiceAssetManifest {
  protocolVersion: 1;
  engineId: 'windows-system-speech';
  voiceName: string;
  assets: VoiceAssetManifestEntry[];
}
