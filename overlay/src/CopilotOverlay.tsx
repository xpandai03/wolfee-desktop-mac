import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export default function CopilotOverlay() {
  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void win.hide();
      }
    };
    window.addEventListener("keydown", handleKey);

    // Hide when window loses focus (click-outside dismiss).
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        void win.hide();
      }
    });

    return () => {
      window.removeEventListener("keydown", handleKey);
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="w-full h-full flex items-start justify-center p-3">
      <div
        className="w-full px-6 py-5 rounded-2xl border border-copilot-accent/40 shadow-2xl shadow-copilot-glow bg-zinc-950/85 backdrop-blur-md text-white"
        role="dialog"
        aria-label="Wolfee Copilot suggestion overlay"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-copilot-accent shadow-[0_0_8px_var(--tw-shadow-color)] shadow-copilot-accent" />
          <h1 className="text-base font-semibold tracking-tight">Wolfee Copilot</h1>
        </div>
        <p className="text-2xl font-semibold mt-3 leading-tight">Hello Copilot</p>
        <p className="text-xs text-zinc-400 mt-2">
          Press <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">Esc</kbd> or click
          outside to dismiss.
        </p>
      </div>
    </div>
  );
}
