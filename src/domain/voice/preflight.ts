import type { DeliveryStyle } from '../showpack/schema.js';

export type VoicePreflightState = 'preparing' | 'ready' | 'error';
export type VoiceEngineId = 'windows-system-speech' | 'chatterbox-tts' | 'qwen3-tts';

export interface VoiceQualityRetryActivity {
  type: 'quality-retry';
  attempt: number;
  maximumAttempts: number;
}

export interface VoiceQualityDeferredActivity {
  type: 'quality-deferred';
  parkedCount: number;
}

export interface VoiceQualityRescueStartedActivity {
  type: 'quality-rescue-started';
  parkedCount: number;
  rescueTotal: number;
  maximumAttempts: number;
}

export interface VoiceQualityRescueAttemptActivity {
  type: 'quality-rescue-attempt';
  rescueIndex: number;
  rescueTotal: number;
  attempt: number;
  maximumAttempts: number;
}

export interface VoiceQualityRescueRecoveredActivity {
  type: 'quality-rescue-recovered';
  remainingParked: number;
}

export interface VoiceQualityRescueExhaustedActivity {
  type: 'quality-rescue-exhausted';
  attempts: number;
}

export interface VoiceQualityRescueCompleteActivity {
  type: 'quality-rescue-complete';
  recoveredCount: number;
  failedCount: number;
}

export type VoicePreflightActivity =
  | VoiceQualityRetryActivity
  | VoiceQualityDeferredActivity
  | VoiceQualityRescueStartedActivity
  | VoiceQualityRescueAttemptActivity
  | VoiceQualityRescueRecoveredActivity
  | VoiceQualityRescueExhaustedActivity
  | VoiceQualityRescueCompleteActivity;

export interface VoicePreflightStatus {
  state: VoicePreflightState;
  completed: number;
  total: number;
  rendered: number;
  cached: number;
  voiceName: string;
  message: string;
  activity: VoicePreflightActivity | null;
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
  engineId: VoiceEngineId;
  voiceName: string;
  assets: VoiceAssetManifestEntry[];
}
