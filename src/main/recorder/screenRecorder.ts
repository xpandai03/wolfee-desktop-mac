import { desktopCapturer, BrowserWindow } from 'electron';

/**
 * Screen recording via Electron's desktopCapturer API.
 * This requires a hidden renderer window to access MediaRecorder.
 * For MVP, screen recording is optional and can be enabled later.
 */
export class ScreenRecorder {
  private hiddenWindow: BrowserWindow | null = null;

  async getAvailableSources() {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  }

  // Screen recording will be implemented in Stage 3
  // It requires a hidden BrowserWindow with MediaRecorder API
  // For now, audio-only recording is the MVP
}
