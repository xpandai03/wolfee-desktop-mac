import { app, dialog, Notification } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';

const MANIFEST_URL = process.env.WOLFEE_UPDATE_URL
  || 'https://cdn.wolfee.io/releases/latest.json';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY = 10_000; // 10s after boot

interface UpdateManifest {
  version: string;
  url: string;
  notes: string;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; notes: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

type StatusListener = (status: UpdateStatus) => void;

export class Updater {
  private status: UpdateStatus = { state: 'idle' };
  private listeners: StatusListener[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private downloadedAppPath: string | null = null;
  private manifest: UpdateManifest | null = null;

  /** Start periodic checks. Call once on app boot. */
  start(): void {
    // Delay first check so app boots fast
    setTimeout(() => this.check(), STARTUP_DELAY);
    this.intervalId = setInterval(() => this.check(), CHECK_INTERVAL);
    console.log(`[Updater] Started — checking ${MANIFEST_URL} every 6h (first in 10s)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onStatus(fn: StatusListener): void {
    this.listeners.push(fn);
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Manually trigger a check. */
  async check(): Promise<void> {
    if (this.status.state === 'downloading' || this.status.state === 'ready') {
      console.log(`[Updater] Skipping check — already ${this.status.state}`);
      return;
    }

    this.setStatus({ state: 'checking' });

    try {
      console.log(`[Updater] Fetching ${MANIFEST_URL}`);
      const { data } = await axios.get<UpdateManifest>(MANIFEST_URL, { timeout: 10000 });

      if (!data.version || !data.url) {
        console.log('[Updater] Invalid manifest — missing version or url');
        this.setStatus({ state: 'idle' });
        return;
      }

      const current = app.getVersion();
      console.log(`[Updater] Current=${current}, Latest=${data.version}`);

      if (this.isNewer(data.version, current)) {
        console.log(`[Updater] Update available: ${data.version}`);
        this.manifest = data;
        this.setStatus({ state: 'available', version: data.version, notes: data.notes });
      } else {
        console.log('[Updater] Already up to date');
        this.setStatus({ state: 'idle' });
      }
    } catch (err: any) {
      console.error(`[Updater] Check failed: ${err.message}`);
      // Don't show errors for update checks — silent failure
      this.setStatus({ state: 'idle' });
    }
  }

  /** Download + extract the update. Call when user opts in. */
  async downloadAndPrepare(): Promise<void> {
    if (!this.manifest) {
      console.error('[Updater] No manifest — call check() first');
      return;
    }

    const { version, url } = this.manifest;
    const updatesDir = path.join(app.getPath('userData'), 'updates');
    const zipPath = path.join(updatesDir, `wolfee-desktop-${version}.zip`);
    const extractDir = path.join(updatesDir, `wolfee-desktop-${version}`);

    try {
      // Clean previous downloads
      if (fs.existsSync(updatesDir)) {
        fs.rmSync(updatesDir, { recursive: true, force: true });
      }
      fs.mkdirSync(updatesDir, { recursive: true });

      // Download with progress
      console.log(`[Updater] Downloading ${url}`);
      this.setStatus({ state: 'downloading', version, percent: 0 });

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 300000, // 5 min for large downloads
        onDownloadProgress: (event) => {
          if (event.total) {
            const percent = Math.round((event.loaded / event.total) * 100);
            this.setStatus({ state: 'downloading', version, percent });
          }
        },
      });

      fs.writeFileSync(zipPath, Buffer.from(response.data));
      const sizeMB = (response.data.byteLength / 1024 / 1024).toFixed(1);
      console.log(`[Updater] Downloaded ${sizeMB} MB to ${zipPath}`);

      // Extract with ditto (preserves macOS signatures)
      console.log(`[Updater] Extracting to ${extractDir}`);
      fs.mkdirSync(extractDir, { recursive: true });
      execSync(`ditto -x -k "${zipPath}" "${extractDir}"`);

      // Find the .app inside
      const entries = fs.readdirSync(extractDir);
      const appEntry = entries.find((e: string) => e.endsWith('.app'));
      if (!appEntry) {
        throw new Error('No .app found in downloaded zip');
      }

      this.downloadedAppPath = path.join(extractDir, appEntry);
      console.log(`[Updater] Ready to install: ${this.downloadedAppPath}`);

      // Clean up zip
      fs.unlinkSync(zipPath);

      this.setStatus({ state: 'ready', version });

      // Show notification
      if (Notification.isSupported()) {
        new Notification({
          title: 'Wolfee Update Ready',
          body: `Version ${version} is ready. Click "Restart to Update" in the tray menu.`,
          silent: true,
        }).show();
      }
    } catch (err: any) {
      console.error(`[Updater] Download/extract failed: ${err.message}`);
      this.setStatus({ state: 'error', message: `Download failed: ${err.message}` });
      // Clean up on failure
      if (fs.existsSync(updatesDir)) {
        fs.rmSync(updatesDir, { recursive: true, force: true });
      }
    }
  }

  /** Replace the running app and relaunch. */
  async installAndRestart(): Promise<void> {
    if (!this.downloadedAppPath || !fs.existsSync(this.downloadedAppPath)) {
      console.error('[Updater] No downloaded app to install');
      dialog.showErrorBox('Update Error', 'Update file not found. Please try again.');
      return;
    }

    // Determine where the current app is installed
    const exePath = app.getPath('exe');
    // exe is at: /path/to/Wolfee Desktop.app/Contents/MacOS/Wolfee Desktop
    const currentAppPath = path.resolve(exePath, '..', '..', '..');

    if (!currentAppPath.endsWith('.app')) {
      console.error(`[Updater] Cannot determine app bundle path from exe: ${exePath}`);
      // Fallback: open the downloaded app and let user handle it
      exec(`open "${this.downloadedAppPath}"`);
      return;
    }

    console.log(`[Updater] Installing update...`);
    console.log(`[Updater] Current app: ${currentAppPath}`);
    console.log(`[Updater] New app: ${this.downloadedAppPath}`);

    // Write a shell script that:
    // 1. Waits for the current process to exit
    // 2. Removes the old app
    // 3. Moves the new app into place
    // 4. Clears quarantine
    // 5. Launches the new app
    const installerScript = path.join(app.getPath('userData'), 'update-installer.sh');
    const pid = process.pid;

    const script = `#!/bin/bash
# Wolfee Desktop Update Installer
# Wait for the old process to exit
echo "[Update] Waiting for PID ${pid} to exit..."
while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done
echo "[Update] Old process exited"

# Replace app
rm -rf "${currentAppPath}"
mv "${this.downloadedAppPath}" "${currentAppPath}"
xattr -cr "${currentAppPath}"

echo "[Update] App replaced, launching..."
open "${currentAppPath}"

# Clean up
rm -rf "${path.join(app.getPath('userData'), 'updates')}"
rm -f "${installerScript}"
`;

    fs.writeFileSync(installerScript, script, { mode: 0o755 });
    console.log(`[Updater] Wrote installer script: ${installerScript}`);

    // Launch the installer script in the background
    const child = exec(`bash "${installerScript}"`, { detached: true, stdio: 'ignore' } as any);
    child.unref?.();

    console.log('[Updater] Installer launched, quitting app...');

    // Quit the app — the script will handle the rest
    app.quit();
  }

  private isNewer(remote: string, local: string): boolean {
    const r = remote.split('.').map(Number);
    const l = local.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    for (const fn of this.listeners) {
      try { fn(status); } catch {}
    }
  }
}
