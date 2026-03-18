import { BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import store, { getBackendUrl } from './store';

const PAIRING_WINDOW_WIDTH = 400;
const PAIRING_WINDOW_HEIGHT = 340;

export function isPaired(): boolean {
  const token = store.get('authToken');
  const userId = store.get('userId');
  return Boolean(token && userId);
}

export function showPairingWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: PAIRING_WINDOW_WIDTH,
      height: PAIRING_WINDOW_HEIGHT,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: 'hiddenInset',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'pairing.html'));

    // Open DevTools in dev mode to debug
    if (!require('electron').app.isPackaged) {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    win.once('ready-to-show', () => {
      win.show();
      win.center();
    });

    // ── Cleanup: remove ALL handlers before registering ──
    // This prevents "second handler" crashes on re-open
    const cleanup = () => {
      try { ipcMain.removeHandler('pair-with-code'); } catch {}
      ipcMain.removeAllListeners('skip-pairing');
      ipcMain.removeAllListeners('open-external');
    };

    // Clean up stale handlers BEFORE registering new ones
    cleanup();

    win.on('closed', () => {
      cleanup();
      resolve(isPaired());
    });

    // ── pair-with-code: invoke/handle roundtrip ──
    console.log('[Pairing:Main] Registering pair-with-code handler');

    ipcMain.handle('pair-with-code', async (_event, code: string) => {
      console.log('[Pairing:Main] ── pair-with-code invoked ──');
      console.log(`[Pairing:Main] code="${code}", type=${typeof code}`);

      try {
        const backendUrl = getBackendUrl();
        const deviceId = store.get('deviceId') || uuidv4();
        const endpoint = `${backendUrl}/api/devices/pair`;
        const body = {
          code: code.trim(),
          deviceId,
          deviceName: `${process.platform} Desktop`,
        };

        console.log(`[Pairing:Main] POST ${endpoint}`);
        console.log(`[Pairing:Main] Body: ${JSON.stringify(body)}`);

        const response = await axios.post(endpoint, body, { timeout: 10000 });

        console.log(`[Pairing:Main] Response: status=${response.status}, data=${JSON.stringify(response.data)}`);

        const { authToken, userId } = response.data;

        if (!authToken) {
          console.error('[Pairing:Main] Server response missing authToken');
          return { success: false, error: 'Server returned invalid response (missing token).' };
        }
        if (!userId) {
          console.error('[Pairing:Main] Server response missing userId');
          return { success: false, error: 'Server returned invalid response (missing userId).' };
        }

        store.set('authToken', authToken);
        store.set('userId', String(userId));
        store.set('deviceId', deviceId);

        console.log(`[Pairing:Main] ── SUCCESS ── userId=${userId}, deviceId=${deviceId}`);

        setTimeout(() => {
          if (!win.isDestroyed()) win.close();
        }, 1000);

        return { success: true };

      } catch (err: any) {
        const httpStatus = err.response?.status;
        const serverMessage = err.response?.data?.message;

        console.error('[Pairing:Main] ── FAILED ──');
        console.error(`[Pairing:Main] HTTP=${httpStatus || 'N/A'}, code=${err.code || 'N/A'}, msg=${err.message}`);

        let userMessage: string;
        if (serverMessage) {
          userMessage = serverMessage;
        } else if (err.code === 'ECONNREFUSED') {
          userMessage = 'Cannot reach Wolfee server. Check your internet connection.';
        } else if (err.code === 'ENOTFOUND') {
          userMessage = 'Cannot resolve server address. Check your internet connection.';
        } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
          userMessage = 'Connection timed out. Try again.';
        } else {
          userMessage = err.message || 'Pairing failed. Please try again.';
        }

        return { success: false, error: userMessage };
      }
    });

    ipcMain.on('skip-pairing', () => {
      console.log('[Pairing] Skipped');
      if (!win.isDestroyed()) win.close();
    });

    ipcMain.on('open-external', (_event, url: string) => {
      shell.openExternal(url);
    });
  });
}
