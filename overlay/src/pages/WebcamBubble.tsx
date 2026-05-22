//! Floating webcam bubble (recorder — iteration 3).
//!
//! Rendered into its own Tauri window via the `#/webcam-bubble` hash
//! route. The window is deliberately NOT content-protected, so this
//! circle — with the live camera feed — is captured by ScreenCaptureKit
//! and appears in the recorded video, like Loom's bubble.
//!
//! This is the only webview that calls `getUserMedia`, so there's no
//! camera contention with the panel. Dragging is handled by the
//! `data-tauri-drag-region` layer; size buttons emit a `wolfee-action`
//! that Rust turns into a window resize.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import clsx from "clsx";

type Size = "small" | "medium" | "large";

export function WebcamBubble() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [size, setSize] = useState<Size>("medium");
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function pickSize(s: Size) {
    setSize(s);
    void emit("wolfee-action", `webcam-bubble-${s}`);
  }

  function close() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void emit("wolfee-action", "webcam-bubble-close");
  }

  return (
    <div className="group relative h-screen w-screen select-none">
      {/* The circle — 14px transparent inset leaves room for the shadow. */}
      <div className="absolute inset-[14px] overflow-hidden rounded-full bg-[#16161a] shadow-[0_8px_30px_rgba(0,0,0,0.45)] ring-1 ring-white/15">
        {error ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-[11px] text-white/55">
            Camera unavailable
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-cover"
            style={{ transform: "scaleX(-1)" }}
          />
        )}

        {/* Drag layer — covers the circle, sits under the controls. */}
        <div data-tauri-drag-region className="absolute inset-0 z-10" />

        {/* Close — top-right, on hover. */}
        <button
          onClick={close}
          title="Turn off camera"
          className="absolute right-2 top-2 z-20 grid h-6 w-6 place-items-center rounded-full bg-black/45 text-white/85 opacity-0 transition-opacity hover:bg-black/65 group-hover:opacity-100"
        >
          <X size={13} />
        </button>

        {/* Size controls — bottom, on hover. */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/55 to-transparent pb-2.5 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
          <SizeButton active={size === "small"} onClick={() => pickSize("small")} title="Small">
            <span className="block h-[7px] w-[7px] rounded-full bg-current" />
          </SizeButton>
          <SizeButton active={size === "medium"} onClick={() => pickSize("medium")} title="Medium">
            <span className="block h-[11px] w-[11px] rounded-full bg-current" />
          </SizeButton>
          <SizeButton active={size === "large"} onClick={() => pickSize("large")} title="Large">
            <span className="block h-[15px] w-[15px] rounded-full bg-current" />
          </SizeButton>
        </div>
      </div>
    </div>
  );
}

function SizeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        "grid h-6 w-6 place-items-center rounded-full transition-colors",
        active ? "bg-white text-[#16161a]" : "bg-black/40 text-white/75 hover:bg-black/65",
      )}
    >
      {children}
    </button>
  );
}

export default WebcamBubble;
