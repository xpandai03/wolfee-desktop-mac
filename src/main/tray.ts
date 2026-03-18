import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';

type TrayAction = 'start' | 'stop' | 'open' | 'pair' | 'debug' | 'update' | 'setup-audio' | 'quit';

export class TrayController {
  private tray: Tray | null = null;
  private isRecording = false;
  private paired = false;
  private hasSystemAudio = false;
  private updateLabel: string | null = null;
  private onAction: (action: TrayAction) => void;

  constructor(onAction: (action: TrayAction) => void) {
    this.onAction = onAction;
  }

  create(): void {
    const icon = this.createIcon(false);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Wolfee Desktop');
    this.updateMenu();
  }

  setPaired(paired: boolean): void {
    this.paired = paired;
    this.updateMenu();
  }

  setSystemAudio(available: boolean): void {
    this.hasSystemAudio = available;
    this.updateMenu();
  }

  setRecording(recording: boolean): void {
    this.isRecording = recording;
    if (this.tray) {
      this.tray.setImage(this.createIcon(recording));
      this.tray.setToolTip(recording ? 'Wolfee — Recording...' : 'Wolfee Desktop');
    }
    this.updateMenu();
  }

  /** Set update-related label shown in menu. null = hide update item. */
  setUpdateLabel(label: string | null): void {
    this.updateLabel = label;
    this.updateMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private updateMenu(): void {
    if (!this.tray) return;

    const items: Electron.MenuItemConstructorOptions[] = [];

    if (!this.paired) {
      items.push({
        label: 'Pair with Wolfee...',
        click: () => this.onAction('pair'),
      });
      items.push({ type: 'separator' });
    }

    if (this.isRecording) {
      const mode = this.hasSystemAudio ? 'Mic + System Audio' : 'Mic Only';
      items.push({
        label: `Recording: ${mode}`,
        enabled: false,
      });
      items.push({
        label: 'Stop Recording',
        click: () => this.onAction('stop'),
        accelerator: 'CmdOrCtrl+Alt+Space',
      });
    } else {
      items.push({
        label: 'Start Recording',
        click: () => this.onAction('start'),
        accelerator: 'CmdOrCtrl+Alt+Space',
      });
    }

    if (!this.hasSystemAudio) {
      items.push({
        label: 'Setup System Audio...',
        click: () => this.onAction('setup-audio'),
      });
    }

    items.push({ type: 'separator' });

    // Update item (shown only when there's something to say)
    if (this.updateLabel) {
      items.push({
        label: this.updateLabel,
        click: () => this.onAction('update'),
      });
      items.push({ type: 'separator' });
    }

    items.push({
      label: 'Open Wolfee',
      click: () => this.onAction('open'),
    });
    items.push({
      label: 'Show Backend URL',
      click: () => this.onAction('debug'),
    });
    items.push({ type: 'separator' });
    items.push({
      label: `Version ${app.getVersion()}`,
      enabled: false,
    });
    items.push({
      label: 'Quit Wolfee',
      accelerator: 'CmdOrCtrl+Q',
      click: () => this.onAction('quit'),
    });

    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  private createIcon(recording: boolean): Electron.NativeImage {
    const size = 16;

    const iconName = recording ? 'trayIconRecording.png' : 'trayIcon.png';
    const iconPath = path.join(__dirname, '..', '..', 'assets', iconName);

    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        return img.resize({ width: size, height: size });
      }
    } catch {
      // Fall through to generated icon
    }

    const canvas = Buffer.alloc(size * size * 4);
    const color = recording ? [255, 59, 48, 255] : [100, 100, 100, 255];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = size / 2;
        const cy = size / 2;
        const r = size / 2 - 1;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const idx = (y * size + x) * 4;

        if (dist <= r) {
          canvas[idx] = color[0];
          canvas[idx + 1] = color[1];
          canvas[idx + 2] = color[2];
          canvas[idx + 3] = color[3];
        } else {
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 0;
        }
      }
    }

    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }
}
