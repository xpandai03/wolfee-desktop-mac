import { globalShortcut } from 'electron';

type HotkeyCallback = () => void;

export function registerHotkeys(onToggleRecording: HotkeyCallback, onQuit: HotkeyCallback): void {
  const recordAccelerator = 'CommandOrControl+Alt+Space';
  const quitAccelerator = 'CommandOrControl+Q';

  const recRegistered = globalShortcut.register(recordAccelerator, () => {
    console.log(`[HOTKEY] Pressed Cmd+Opt+Space`);
    onToggleRecording();
  });

  if (!recRegistered) {
    console.error(`[HOTKEY] Failed to register ${recordAccelerator} — another app may have claimed it`);
  } else {
    console.log(`[HOTKEY] Registered ${recordAccelerator}`);
  }

  const quitRegistered = globalShortcut.register(quitAccelerator, () => {
    console.log(`[Hotkeys] ${quitAccelerator} pressed`);
    onQuit();
  });

  if (!quitRegistered) {
    console.error(`[Hotkeys] Failed to register ${quitAccelerator}`);
  } else {
    console.log(`[Hotkeys] Registered ${quitAccelerator}`);
  }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
  console.log('[Hotkeys] All hotkeys unregistered');
}
