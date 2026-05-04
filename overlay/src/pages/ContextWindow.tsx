import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";

/**
 * Sub-prompt 4.5 context paste page.
 *
 * Rendered into the same overlay HTML bundle but routed at
 * `index.html#/context` so the dedicated WebviewWindowBuilder window
 * loads this view rather than the main overlay. Three textareas with
 * char counters; Submit/Cancel; Esc cancels; Cmd+Enter submits.
 *
 * Submitting emits a `wolfee-action` event with type=submit-copilot-
 * context — the Rust handle_structured_action dispatcher in lib.rs
 * creates the backend session, POSTs /context, spawns audio +
 * intelligence workers, shows the overlay, and destroys this window.
 * Cancelling emits type=cancel-copilot-context which just destroys
 * the window.
 *
 * Empty submission is allowed (graceful degradation to pre-4.5
 * behavior — prompts will see "(not provided)" placeholders).
 */

interface FieldConfig {
  key: "about_user" | "about_call" | "objections";
  label: string;
  placeholder: string;
  maxChars: number;
}

const FIELDS: FieldConfig[] = [
  {
    key: "about_user",
    label: "About you / your company",
    maxChars: 2000,
    placeholder:
      "I'm Raunek at Xpand Technology, an AI automation agency. We've shipped HIPAA-compliant n8n + Power Automate replacements at 5 clinics including TFC. Average implementation: 6 weeks, $40-80k contract value.",
  },
  {
    key: "about_call",
    label: "About this call",
    maxChars: 1000,
    placeholder:
      "Discovery call with Dr. Smith from Sunset Vasectomy Clinic. They flagged DrChrono integration concerns + want HIPAA review. Decision likely within 2 weeks.",
  },
  {
    key: "objections",
    label: "Expected objections / things to handle",
    maxChars: 500,
    placeholder:
      "Pricing (we're 30% above competitor), 6-week timeline feels slow, integration with existing DrChrono install.",
  },
];

type Fields = Record<FieldConfig["key"], string>;

const initialFields: Fields = {
  about_user: "",
  about_call: "",
  objections: "",
};

export function ContextWindow() {
  const [fields, setFields] = useState<Fields>(initialFields);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-focus first textarea on mount.
    firstFieldRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      // Snake_case keys — the Rust dispatcher reads via
      // serde_json::Value::get("about_user") etc., so the JS payload
      // shape must match exactly (no camelCase auto-conversion here
      // because we're going through wolfee-action, not Tauri commands).
      await emit("wolfee-action", {
        type: "submit-copilot-context",
        about_user: fields.about_user.trim() || null,
        about_call: fields.about_call.trim() || null,
        objections: fields.objections.trim() || null,
      });
      // Rust closes this window once the session-start flow lands;
      // nothing to do here. Leave isSubmitting=true so the form
      // stays disabled — the window is about to be destroyed.
    } catch (err) {
      console.error("[ContextWindow] submit emit failed:", err);
      setErrorMsg(typeof err === "string" ? err : "Failed to start session");
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    try {
      await emit("wolfee-action", "cancel-copilot-context");
    } catch (err) {
      console.error("[ContextWindow] cancel emit failed:", err);
    }
  };

  // Esc → cancel; Cmd/Ctrl+Enter → submit.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // handleSubmit references state but we want a stable handler bound
    // to the latest closure each render — so re-attach when fields change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, isSubmitting]);

  return (
    <div className="h-screen w-screen bg-zinc-950 text-zinc-100 flex flex-col p-6 gap-4 overflow-y-auto">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Set up this Copilot session</h1>
        <p className="text-xs text-zinc-400">
          Paste context below to make suggestions specific to this call. All
          fields optional — leave blank for generic mode.
        </p>
      </header>

      <div className="flex flex-col gap-3 flex-1">
        {FIELDS.map((field, i) => {
          const value = fields[field.key];
          return (
            <div key={field.key} className="flex flex-col gap-1">
              <label
                htmlFor={`ctx-${field.key}`}
                className="text-[11px] font-medium uppercase tracking-wider text-zinc-300"
              >
                {field.label}
              </label>
              <textarea
                id={`ctx-${field.key}`}
                ref={i === 0 ? firstFieldRef : undefined}
                placeholder={field.placeholder}
                value={value}
                disabled={isSubmitting}
                onChange={(e) =>
                  setFields((prev) => ({
                    ...prev,
                    [field.key]: e.target.value.slice(0, field.maxChars),
                  }))
                }
                maxLength={field.maxChars}
                rows={field.key === "about_user" ? 4 : 3}
                className="resize-none rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-copilot-accent focus:outline-none disabled:opacity-50"
              />
              <div className="text-[10px] text-zinc-500 text-right">
                {value.length} / {field.maxChars}
              </div>
            </div>
          );
        })}
      </div>

      {errorMsg !== null && (
        <p className="text-xs text-red-400" role="alert">
          {errorMsg}
        </p>
      )}

      <footer className="flex items-center justify-between gap-2 mt-auto">
        <p className="text-[11px] text-zinc-500">
          Esc to cancel · ⌘↵ to start
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm bg-copilot-accent text-zinc-950 rounded-md font-medium disabled:opacity-50 hover:bg-cyan-300 transition-colors min-w-[140px]"
          >
            {isSubmitting ? "Starting…" : "Start Session"}
          </button>
        </div>
      </footer>
    </div>
  );
}

export default ContextWindow;
