import React, { useEffect, useRef, useState } from "react";
import { Plus, MessageSquare, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatThread } from "@/state/types";

/**
 * Sub-prompt 4.7 — thread switcher rendered at the top of the Chat
 * tab. Shows a small chip-row of existing threads + a [+ New chat]
 * button. Long-press / right-click a chip to delete (V1 — no
 * inline rename UI yet, deferred to Sub-prompt 6 polish).
 *
 * Empty state: just the [+ New chat] button. The first user-typed
 * question or quick-action click also auto-creates a thread, so
 * the user doesn't strictly need to click this — it's there for
 * "I want a fresh conversation now" and "let me jump back to
 * thread 2."
 */

interface Props {
  threads: ChatThread[];
  activeThreadId: string | null;
  onNewThread: () => void;
  onSwitchThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
}

export function ThreadSwitcher({
  threads,
  activeThreadId,
  onNewThread,
  onSwitchThread,
  onDeleteThread,
}: Props) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/5 overflow-x-auto chat-scroll shrink-0">
      <button
        type="button"
        onClick={onNewThread}
        title="New chat (⌘⇧N)"
        aria-label="New chat"
        className={cn(
          "inline-flex items-center gap-1 px-2 py-1 rounded-md shrink-0",
          "text-[11px] font-medium",
          "border border-white/10 bg-zinc-900/60",
          "text-zinc-300 hover:text-copilot-accent hover:border-copilot-accent/40",
          "transition-colors cursor-pointer",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
        )}
      >
        <Plus className="w-3 h-3" />
        <span>New chat</span>
      </button>

      {threads.length > 0 && (
        <span className="text-zinc-700 px-1 select-none">·</span>
      )}

      {threads.map((t) => (
        <ThreadChip
          key={t.id}
          thread={t}
          active={t.id === activeThreadId}
          onClick={() => onSwitchThread(t.id)}
          onDelete={() => onDeleteThread(t.id)}
        />
      ))}
    </div>
  );
}

interface ChipProps {
  thread: ChatThread;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}

function ThreadChip({ thread, active, onClick, onDelete }: ChipProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const longPressTimer = useRef<number | null>(null);

  // Reset confirm state if user navigates away.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  const handleMouseDown = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => {
      setConfirmDelete(true);
    }, 600);
  };
  const handleMouseUp = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setConfirmDelete(true);
  };

  if (confirmDelete) {
    return (
      <div className="inline-flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={() => {
            setConfirmDelete(false);
            onDelete();
          }}
          aria-label={`Delete ${thread.name}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 cursor-pointer"
        >
          <Trash2 className="w-3 h-3" />
          <span>Delete</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirmDelete(false)}
          aria-label="Cancel delete"
          className="inline-flex items-center px-1.5 py-1 rounded-md text-[11px] font-medium border border-white/10 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 cursor-pointer"
        >
          <Check className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      title={`${thread.name} — long-press / right-click to delete`}
      aria-label={`Switch to ${thread.name}`}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded-md shrink-0",
        "text-[11px] font-medium",
        "border transition-colors cursor-pointer",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
        active
          ? "border-copilot-accent/40 bg-copilot-accent/10 text-copilot-accent"
          : "border-white/10 bg-zinc-900/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900",
      )}
    >
      <MessageSquare className="w-3 h-3" />
      <span className="truncate max-w-[80px]">{thread.name}</span>
    </button>
  );
}
