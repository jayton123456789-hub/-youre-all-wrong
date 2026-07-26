export interface DesktopEpisodeSummary {
  id: string;
  title: string;
  author: string;
  source: 'demo' | 'custom';
}

export interface DesktopEpisodeState {
  episode: DesktopEpisodeSummary;
  warning: string | null;
}

export type DesktopEpisodeActionResult =
  | {
      ok: true;
      episode: DesktopEpisodeSummary;
      restarting: boolean;
    }
  | {
      ok: false;
      cancelled: boolean;
      message: string;
    };

export type DesktopAuthorKitResult =
  | {
      ok: true;
      filePath: string;
    }
  | {
      ok: false;
      cancelled: boolean;
      message: string;
    };

export interface YoureAllWrongDesktopBridge {
  platform: NodeJS.Platform;
  versions: {
    chrome: string;
    electron: string;
  };
  episode: {
    getActive(): Promise<DesktopEpisodeState>;
    choose(): Promise<DesktopEpisodeActionResult>;
    useDemo(): Promise<DesktopEpisodeActionResult>;
    downloadAuthorKit(): Promise<DesktopAuthorKitResult>;
    onRuntimeFailure(listener: (state: DesktopEpisodeState) => void): () => void;
  };
  voice: {
    getInstallationState(): Promise<DesktopVoiceBootstrapState>;
    install(): Promise<DesktopVoiceBootstrapResult>;
    onInstallationProgress(listener: (progress: VoiceInstallationProgress) => void): () => void;
  };
}
import type {
  DesktopVoiceBootstrapResult,
  DesktopVoiceBootstrapState,
  VoiceInstallationProgress,
} from './voice-installation.js';
