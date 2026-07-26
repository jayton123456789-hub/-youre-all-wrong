import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopEpisodeState } from './episode-contract.js';
import type { VoiceInstallationProgress } from './voice-installation.js';

contextBridge.exposeInMainWorld('youreAllWrongDesktop', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  episode: {
    getActive: () => ipcRenderer.invoke('episode:get-active'),
    choose: () => ipcRenderer.invoke('episode:choose'),
    useDemo: () => ipcRenderer.invoke('episode:use-demo'),
    downloadAuthorKit: () => ipcRenderer.invoke('episode:download-author-kit'),
    onRuntimeFailure: (listener: (state: DesktopEpisodeState) => void) => {
      const handleFailure = (_event: Electron.IpcRendererEvent, state: DesktopEpisodeState) =>
        listener(state);
      ipcRenderer.on('episode:runtime-failed', handleFailure);
      return () => ipcRenderer.removeListener('episode:runtime-failed', handleFailure);
    },
  },
  voice: {
    getInstallationState: () => ipcRenderer.invoke('voice:get-installation-state'),
    install: () => ipcRenderer.invoke('voice:install'),
    onInstallationProgress: (listener: (progress: VoiceInstallationProgress) => void) => {
      const handleProgress = (
        _event: Electron.IpcRendererEvent,
        progress: VoiceInstallationProgress,
      ) => listener(progress);
      ipcRenderer.on('voice:installation-progress', handleProgress);
      return () => ipcRenderer.removeListener('voice:installation-progress', handleProgress);
    },
  },
});
