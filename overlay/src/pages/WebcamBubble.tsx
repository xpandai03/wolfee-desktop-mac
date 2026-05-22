//! Floating webcam bubble (recorder — iterations 3 & 4).
//!
//! Its own Tauri window (`#/webcam-bubble`), deliberately NOT
//! content-protected so the camera circle is captured into the
//! recording, like Loom's bubble.
//!
//! Three sizes — small (200 px circle), medium (400 px circle,
//! default), large (fills the display). At `large` the circle becomes
//! a full-bleed rectangle. The window itself is resized by Rust; this
//! component just switches circle ↔ rectangle and highlights the
//! active size.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import { Maximize, X } from "lucide-react";
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

  const fullscreen = size === "large";

  return (
    <div className="group relative h-screen w-screen select-none">
      <div
        className={clsx(
          "absolute overflow-hidden bg-[#16161a]",
          fullscreen
            ? "inset-0"
            : "inset-[14px] rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.45)] ring-1 ring-white/15",
        )}
      >
        {error ? (
          <div className="flex h-full w-full items-center justify-center px-4 text-center text-[12px] text-white/55">
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

        {/* Drag layer — under the controls. */}
        <div data-tauri-drag-region className="absolute inset-0 z-10" />

        {/* Close — top-right, on hover. */}
        <button
          onClick={close}
          title="Turn off camera"
          className="absolute right-2 top-2 z-20 grid h-7 w-7 place-items-center rounded-full bg-black/45 text-white/85 opacity-0 transition-opacity hover:bg-black/65 group-hover:opacity-100"
        >
          <X size={14} />
        </button>

        {/* Size controls — bottom, on hover. */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-2 bg-gradient-to-t from-black/60 to-transparent pb-3 pt-7 opacity-0 transition-opacity group-hover:opacity-100">
          <SizeButton active={size === "small"} onClick={() => pickSize("small")} title="Small">
            <span className="block h-[7px] w-[7px] rounded-full bg-current" />
          </SizeButton>
          <SizeButton active={size === "medium"} onClick={() => pickSize("medium")} title="Medium">
            <span className="block h-[13px] w-[13px] rounded-full bg-current" />
          </SizeButton>
          <SizeButton active={size === "large"} onClick={() => pickSize("large")} title="Full screen">
            <Maximize size={15} />
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
        "grid h-7 w-7 place-items-center rounded-full transition-colors",
        active ? "bg-white text-[#16161a]" : "bg-black/45 text-white/80 hover:bg-black/70",
      )}
    >
      {children}
    </button>
  );
}

export default WebcamBubble;
