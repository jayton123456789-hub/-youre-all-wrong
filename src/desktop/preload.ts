import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('youreAllWrongDesktop', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
