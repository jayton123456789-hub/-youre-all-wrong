import type { YoureAllWrongDesktopBridge } from '../desktop/episode-contract.js';

declare global {
  interface Window {
    youreAllWrongDesktop?: YoureAllWrongDesktopBridge;
  }
}

export {};
