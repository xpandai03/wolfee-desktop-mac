import { BrowserWindow, screen, ipcMain, shell } from 'electron';
import path from 'path';
import { RecordingStateData } from './recordingState';

const WIDGET_WIDTH = 200;
const WIDGET_HEIGHT = 56;
const SCREEN_MARGIN = 16;

/**
 * Floating recording widget — a small always-on-top overlay.
 *
 * Visible during: recording, stopping, uploading, complete.
 * Hidden during: idle.
 *
 * Position: top-right corner of primary display, draggable.
 */
export class RecordingWidget {
  private win: BrowserWindow | null = null;
  private onStopRequested: (() => void) | null = null;
  private lastState: RecordingStateData | null = null;
  private getMeetingUrl: (() => string | null) | null = null;

  constructor(onStopRequested: () => void, getMeetingUrl?: () => string | null) {
    this.onStopRequested = onStopRequested;
    this.getMeetingUrl = getMeetingUrl ?? null;

    ipcMain.on('widget-stop-recording', () => {
      this.onStopRequested?.();
    });

    ipcMain.on('widget-dismiss', () => {
      this.hide();
    });

    ipcMain.on('widget-open-meeting', () => {
      const url = this.getMeetingUrl?.();
      if (url) {
        shell.openExternal(url);
      }
    });
  }

  private createWindow(): BrowserWindow {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW } = primaryDisplay.workAreaSize;

    const x = screenW - WIDGET_WIDTH - SCREEN_MARGIN;
    const y = SCREEN_MARGIN;

    const win = new BrowserWindow({
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      movable: true,
      show: false,
      focusable: false,
      // Keep tray-only: widget should not show in dock
      type: 'panel',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Prevent widget from taking focus
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'widget.html'));

    return win;
  }

  private ensureWindow(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      this.win = this.createWindow();
    }
    return this.win;
  }

  update(data: RecordingStateData): void {
    this.lastState = data;

    if (data.state === 'idle') {
      this.hide();
      return;
    }

    const win = this.ensureWindow();

    // Send state to renderer
    if (!win.isDestroyed()) {
      win.webContents.send('recording-state', data);

      if (!win.isVisible()) {
        win.showInactive();
      }
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  destroy(): void {
    ipcMain.removeAllListeners('widget-stop-recording');
    ipcMain.removeAllListeners('widget-dismiss');
    ipcMain.removeAllListeners('widget-open-meeting');
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
