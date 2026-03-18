import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload] Loading wolfee bridge...');

contextBridge.exposeInMainWorld('wolfee', {
  platform: process.platform,
  pairWithCode: (code: string): Promise<{ success: boolean; error?: string }> => {
    console.log(`[Preload] pairWithCode called, code=${code}`);
    return ipcRenderer.invoke('pair-with-code', code);
  },
  skipPairing: () => {
    console.log('[Preload] skipPairing called');
    ipcRenderer.send('skip-pairing');
  },
  openExternal: (url: string) => {
    console.log(`[Preload] openExternal called, url=${url}`);
    ipcRenderer.send('open-external', url);
  },
  getBackendUrl: (): Promise<string> => {
    return ipcRenderer.invoke('get-backend-url');
  },
  getAppInfo: (): Promise<{ version: string; isPackaged: boolean; backendUrl: string }> => {
    return ipcRenderer.invoke('get-app-info');
  },

  // Widget IPC
  onRecordingState: (callback: (data: any) => void) => {
    ipcRenderer.on('recording-state', (_event, data) => callback(data));
  },
  stopRecording: () => {
    ipcRenderer.send('widget-stop-recording');
  },
  dismissWidget: () => {
    ipcRenderer.send('widget-dismiss');
  },
  openMeeting: () => {
    ipcRenderer.send('widget-open-meeting');
  },
});

console.log('[Preload] wolfee bridge registered');
