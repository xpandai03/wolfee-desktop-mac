import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from 'electron';
import { execSync } from 'child_process';
import fs from 'fs';

// Build ID: derived from the compiled JS file's mtime — changes on every build
const BUILD_ID = (() => {
  try {
    const stat = fs.statSync(__filename);
    return stat.mtime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  } catch {
    return 'unknown';
  }
})();
import path from 'path';
import { TrayController } from './tray';
import { RecorderEngine } from './recorder';
import { UploadQueue } from './uploader/queue';
import { registerHotkeys, unregisterHotkeys } from './hotkeys';
import { isPaired, showPairingWindow } from './pairing';
import { Updater } from './updater';
import { analyzeRecording } from './audioDevices';
import store, { getBackendUrl } from './store';
import { v4 as uuidv4 } from 'uuid';
import { RecordingStateMachine } from './recordingState';
import { RecordingWidget } from './widget';

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// In dev mode, keep dock visible so app appears in Force Quit and Activity Monitor.
// In production, hide dock for tray-only experience.
if (process.platform === 'darwin') {
  if (app.isPackaged) {
    app.dock?.hide();
  } else {
    console.log('[App] Dev mode — keeping dock visible for Force Quit access');
  }
}

let tray: TrayController;
let recorder: RecorderEngine;
let uploadQueue: UploadQueue;
let updater: Updater;
let stateMachine: RecordingStateMachine;
let widget: RecordingWidget;

// Track upload item IDs to correlate with recording lifecycle
let activeUploadItemId: string | null = null;
let lastMeetingUrl: string | null = null;

// Quit state — distinguishes "close window to tray" from "actually quit"
let isQuitting = false;

function toggleRecording(): void {
  const currentState = stateMachine.state;
  console.log(`[HOTKEY] Pressed Cmd+Opt+Space → state=${currentState}`);

  if (currentState === 'stopping' || currentState === 'uploading') {
    console.log(`[HOTKEY] Ignoring — busy (${currentState})`);
    return;
  }

  if (currentState === 'recording') {
    console.log('[HOTKEY] → stopping recording');
    stopRecording();
  } else {
    console.log('[HOTKEY] → starting recording');
    startRecording();
  }
}

async function startRecording(): Promise<void> {
  if (!isPaired()) {
    showNotification('Not paired', 'Pair with your Wolfee account first');
    showPairingFlow();
    return;
  }

  // Guard against rapid double-triggers
  if (stateMachine.state !== 'idle') {
    console.log(`[App] Ignoring start — state is ${stateMachine.state}`);
    return;
  }

  // Re-detect devices in case BlackHole was installed since boot
  const devices = recorder.detectDevices();
  tray.setSystemAudio(devices.hasLoopback);

  if (!devices.hasLoopback) {
    console.log('[App] No system audio device — prompting user');
    // Show dock for the dialog
    if (process.platform === 'darwin') app.dock?.show();

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'System Audio Not Available',
      message: 'Wolfee cannot capture system audio (Zoom, Meet, etc.).',
      detail: 'Without BlackHole installed, only your microphone will be recorded. The other person\'s voice will NOT be captured.\n\nWould you like to set up system audio or record mic-only?',
      buttons: ['Setup System Audio', 'Record Mic Only', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (process.platform === 'darwin') app.dock?.hide();

    if (response === 0) {
      showSystemAudioSetup();
      return;
    }
    if (response === 2) {
      return;
    }
    // response === 1: proceed with mic-only
    console.log('[App] User chose to record mic-only');
  }

  try {
    recorder.start();
    stateMachine.transitionTo('recording');
    tray.setRecording(true);
    const mode = devices.hasLoopback ? 'mic + system audio' : 'mic only';
    showNotification('Recording started', `Capturing ${mode} — press ⌘+⌥+Space to stop`);
    console.log(`[App] Recording started (${mode})`);
  } catch (err: any) {
    console.error('[App] Failed to start recording:', err.message);
    showNotification('Recording failed', err.message);
    stateMachine.reset();
  }
}

async function stopRecording(): Promise<void> {
  // Guard against rapid double-triggers
  if (stateMachine.state !== 'recording') {
    console.log(`[App] Ignoring stop — state is ${stateMachine.state}`);
    return;
  }

  stateMachine.transitionTo('stopping');

  try {
    const hadSystemAudio = recorder.hasSystemAudio;
    const { filePath, metadata } = await recorder.stop();
    tray.setRecording(false);

    // Log file size immediately
    try {
      const stat = fs.statSync(filePath);
      console.log(`[App] Recording file: ${filePath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch {
      console.error(`[App] Recording file not found: ${filePath}`);
    }

    // Post-recording diagnostics
    const analysis = analyzeRecording(filePath);
    console.log(`[App] Recording diagnostics: duration=${analysis.duration.toFixed(1)}s, audio=${analysis.hasAudio}, channels=${analysis.channels}`);
    console.log(`[App] Wall-clock duration: ${metadata.duration.toFixed(1)}s, file duration: ${analysis.duration.toFixed(1)}s`);

    // Warn if file duration is significantly shorter than wall-clock
    if (analysis.duration > 0 && metadata.duration > 0 && analysis.duration < metadata.duration * 0.8) {
      console.warn(`[App] WARNING: File duration (${analysis.duration.toFixed(1)}s) is much shorter than wall-clock (${metadata.duration.toFixed(1)}s) — possible truncation`);
    }

    if (!analysis.hasAudio) {
      showNotification('Recording problem', 'No audio was detected in the recording.');
    } else if (!hadSystemAudio) {
      showNotification(
        'Recording saved (mic only)',
        `${metadata.duration.toFixed(0)}s — only your microphone was captured.`
      );
    }

    // Queue for upload and transition state
    console.log('[App] Recording stopped, queuing upload');
    const uploadId = uploadQueue.enqueue(filePath, metadata);
    activeUploadItemId = uploadId;
    stateMachine.transitionTo('uploading', { uploadItemId: uploadId, duration: metadata.duration });
  } catch (err: any) {
    console.error('[App] Failed to stop recording:', err.message);
    tray.setRecording(false);
    stateMachine.transitionTo('idle', { error: err.message });
  }
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
}

async function showPairingFlow(): Promise<void> {
  // Show dock icon temporarily for pairing window
  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  const paired = await showPairingWindow();

  // Hide dock icon again
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  tray.setPaired(paired);

  if (paired) {
    showNotification('Wolfee paired', 'Press ⌘+⌥+Space to start recording');
  }
}

function showSystemAudioSetup(): void {
  console.log('[App] Showing system audio setup window');
  if (process.platform === 'darwin') app.dock?.show();

  const win = new BrowserWindow({
    width: 520,
    height: 560,
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

  win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'setup-audio.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.center();
  });

  win.on('closed', () => {
    if (process.platform === 'darwin') app.dock?.hide();
    // Re-detect devices after setup window closes
    const devices = recorder.detectDevices();
    tray.setSystemAudio(devices.hasLoopback);
    if (devices.hasLoopback) {
      showNotification('System audio ready', 'BlackHole detected. Your recordings will now capture both sides of conversations.');
    }
  });
}

function recoverOrphanedRecordings(): void {
  const orphaned = recorder.findOrphanedRecordings();
  if (orphaned.length === 0) return;

  console.log(`[App] Found ${orphaned.length} orphaned recording(s) — re-queuing`);
  for (const filePath of orphaned) {
    uploadQueue.enqueue(filePath, {
      userId: store.get('userId') || 'unknown',
      deviceId: store.get('deviceId') || uuidv4(),
      timestamp: new Date().toISOString(),
      duration: 0, // unknown for recovered recordings
      platformGuess: 'unknown',
      source: 'desktop_recorder_recovered',
    });
  }
}

// Dev safeguard: kill stale Wolfee processes from previous runs
if (!app.isPackaged && process.platform === 'darwin') {
  try {
    const myPid = process.pid;
    const out = execSync('pgrep -f "Wolfee Desktop"', { encoding: 'utf8' }).trim();
    const pids = out.split('\n').map(Number).filter((pid) => pid !== myPid && pid > 0);
    if (pids.length > 0) {
      console.log(`[App] Dev safeguard: killing stale Wolfee processes: ${pids.join(', ')}`);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  } catch {
    // pgrep returns non-zero when no matches — that's fine
  }
}

app.whenReady().then(async () => {
  const version = app.getVersion();

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  WOLFEE DESKTOP BOOT');
  console.log('══════════════════════════════════════════');
  console.log(`  version:     ${version}`);
  console.log(`  buildId:     ${BUILD_ID}`);
  console.log(`  isPackaged:  ${app.isPackaged}`);
  console.log(`  backendUrl:  ${getBackendUrl()}`);
  console.log(`  platform:    ${process.platform} ${process.arch}`);
  console.log(`  electron:    ${process.versions.electron}`);
  console.log('══════════════════════════════════════════');
  console.log('');

  // Migrate stale backendUrl from older builds that persisted localhost
  const staleUrl = store.get('backendUrl');
  if (staleUrl) {
    console.log(`[Config] Clearing stale stored backendUrl=${staleUrl}`);
    store.set('backendUrl', '');
  }

  // IPC handlers for renderer queries
  ipcMain.handle('get-backend-url', () => getBackendUrl());
  ipcMain.handle('get-app-info', () => ({
    version,
    buildId: BUILD_ID,
    isPackaged: app.isPackaged,
    backendUrl: getBackendUrl(),
  }));

  // Ensure deviceId exists
  if (!store.get('deviceId')) {
    store.set('deviceId', uuidv4());
  }

  console.log(`[Config] deviceId=${store.get('deviceId')}`);

  // Initialize components
  recorder = new RecorderEngine();
  uploadQueue = new UploadQueue();

  // Initialize recording state machine
  stateMachine = new RecordingStateMachine();

  // Initialize floating widget — pass stop handler + meeting URL getter
  widget = new RecordingWidget(
    () => stopRecording(),
    () => lastMeetingUrl,
  );

  // Wire state machine → widget + tray
  stateMachine.on('change', (data) => {
    widget.update(data);
  });

  // Wire upload completion → state machine + "Open in Wolfee"
  uploadQueue.on('uploaded', (itemId: string, _metadata: any, meetingUrl?: string) => {
    if (stateMachine.state === 'uploading' && activeUploadItemId === itemId) {
      stateMachine.transitionTo('complete');
      activeUploadItemId = null;

      // Show clickable notification that opens the meeting
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: 'Ready in Wolfee',
          body: 'Click to open your recording.',
          silent: true,
        });
        notif.on('click', () => {
          const url = meetingUrl || getBackendUrl();
          shell.openExternal(url);
        });
        notif.show();
      }

      // Store meeting URL for widget "Open" action
      if (meetingUrl) {
        lastMeetingUrl = meetingUrl;
      }
    }
  });

  // Detect audio devices
  const devices = recorder.detectDevices();
  if (!devices.hasLoopback) {
    console.log('[App] No system audio loopback device detected');
  }

  // Create tray
  tray = new TrayController((action) => {
    switch (action) {
      case 'start':
        startRecording();
        break;
      case 'stop':
        stopRecording();
        break;
      case 'open': {
        shell.openExternal(getBackendUrl());
        break;
      }
      case 'pair':
        showPairingFlow();
        break;
      case 'setup-audio':
        showSystemAudioSetup();
        break;
      case 'update': {
        const status = updater.getStatus();
        if (status.state === 'available') {
          updater.downloadAndPrepare();
        } else if (status.state === 'ready') {
          updater.installAndRestart();
        }
        break;
      }
      case 'debug': {
        const debugUrl = getBackendUrl();
        console.log(`[Debug] backendUrl=${debugUrl}, isPackaged=${app.isPackaged}`);
        dialog.showMessageBox({
          type: 'info',
          title: 'Wolfee Debug',
          message: `Backend: ${debugUrl}\nPackaged: ${app.isPackaged}`,
        });
        break;
      }
      case 'quit':
        quitApp();
        break;
    }
  });
  tray.create();
  tray.setPaired(isPaired());
  tray.setSystemAudio(devices.hasLoopback);

  // Auto-updater
  updater = new Updater();
  updater.onStatus((status) => {
    console.log(`[Updater] Status: ${status.state}`);
    switch (status.state) {
      case 'available':
        tray.setUpdateLabel(`Update Available (v${status.version})`);
        break;
      case 'downloading':
        tray.setUpdateLabel(`Downloading Update... ${status.percent}%`);
        break;
      case 'ready':
        tray.setUpdateLabel(`Restart to Update (v${status.version})`);
        break;
      default:
        tray.setUpdateLabel(null);
        break;
    }
  });
  updater.start();

  // Register global hotkeys
  registerHotkeys(toggleRecording, quitApp);

  // Start upload queue processor
  uploadQueue.start();

  // Recover any orphaned recordings from crashes
  recoverOrphanedRecordings();

  // Show pairing window on first launch
  if (!isPaired()) {
    console.log('[App] Not paired — showing pairing window');
    showPairingFlow();
  }

  console.log('[App] Wolfee Desktop ready — ⌘+⌥+Space to record');
});

/** Cleanly quit the app — kill ffmpeg, tear down everything, then exit. */
function quitApp(): void {
  if (isQuitting) return;
  isQuitting = true;
  console.log('[APP] Quit initiated');

  // 1. Kill ffmpeg immediately
  console.log('[APP] Stopping recording / killing ffmpeg');
  recorder?.forceKill();

  // 2. Stop background services
  console.log('[APP] Stopping upload queue');
  uploadQueue?.stop();

  console.log('[APP] Stopping updater');
  updater?.stop();

  // 3. Tear down UI
  console.log('[APP] Destroying widget');
  widget?.destroy();

  console.log('[APP] Destroying tray');
  tray?.destroy();

  // 4. Unregister hotkeys
  console.log('[APP] Unregistering hotkeys');
  unregisterHotkeys();

  // 5. Kill any orphaned ffmpeg child processes (belt-and-suspenders)
  if (process.platform === 'darwin') {
    try {
      execSync('pkill -9 -f "ffmpeg.*wolfee"', { encoding: 'utf8' });
      console.log('[APP] Killed orphaned ffmpeg processes');
    } catch {
      // No matching processes — expected
    }
  }

  // 6. Request Electron quit
  console.log('[APP] Calling app.quit()');
  app.quit();

  // 7. Safety net: if app.quit() doesn't exit within 3s, force-kill
  setTimeout(() => {
    console.error('[APP] app.quit() did not exit in time — forcing process.exit(0)');
    process.exit(0);
  }, 3000).unref(); // .unref() so this timer alone doesn't keep Node alive
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  console.log('[APP] will-quit — final cleanup');
  // Defensive: repeat cleanup in case quit came from Cmd+Q or system
  unregisterHotkeys();
  recorder?.forceKill();
  updater?.stop();
  uploadQueue?.stop();
  widget?.destroy();
  tray?.destroy();
  console.log('[APP] Exiting process');
});

// Keep app alive when all windows close (tray-only), but allow actual quit
app.on('window-all-closed', (e: Event) => {
  if (!isQuitting) {
    e.preventDefault();
  }
});
