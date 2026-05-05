import { useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ChevronDown, Star, Save, Loader2 } from "lucide-react";

/**
 * Sub-prompt 4.5 → 4.8 — context paste page.
 *
 * Sub-prompt 4.5: 3 textareas (about_user / about_call / objections),
 * Cmd+Enter submits, Esc cancels. Sub-prompt 4.8 layered on:
 *   - Mode selector dropdown above the textareas
 *   - On mount: fetches user's saved Modes via wolfee-action +
 *     auto-loads the default Mode if any
 *   - "Save as Mode" inline form when fields are dirty
 *   - mode_used_id forwarded with the submit payload
 *
 * Window itself is destroyed/recreated per session, so any state
 * here is fine to keep in React (no persistence needed).
 */

interface FieldConfig {
  key: "about_user" | "about_call" | "objections";
  label: string;
  placeholder: string;
  maxChars: number;
}

interface CopilotMode {
  id: string;
  name: string;
  description: string | null;
  contextAboutUser: string | null;
  contextAboutCall: string | null;
  contextObjections: string | null;
  isDefault: boolean;
}

const FIELDS: FieldConfig[] = [
  {
    key: "about_user",
    label: "About you / your company",
    maxChars: 2000,
    placeholder: "I'm Raunek at Xpand Technology, an AI automation agency...",
  },
  {
    key: "about_call",
    label: "About this call",
    maxChars: 1000,
    placeholder: "Discovery call with Dr. Smith from Sunset Vasectomy Clinic...",
  },
  {
    key: "objections",
    label: "Expected objections / things to handle",
    maxChars: 500,
    placeholder: "Pricing concerns, HIPAA compliance, timeline...",
  },
];

type Fields = Record<FieldConfig["key"], string>;

const initialFields: Fields = {
  about_user: "",
  about_call: "",
  objections: "",
};

function fieldsFromMode(mode: CopilotMode): Fields {
  return {
    about_user: mode.contextAboutUser ?? "",
    about_call: mode.contextAboutCall ?? "",
    objections: mode.contextObjections ?? "",
  };
}

function fieldsAreEqual(a: Fields, b: Fields): boolean {
  return (
    a.about_user === b.about_user &&
    a.about_call === b.about_call &&
    a.objections === b.objections
  );
}

export function ContextWindow() {
  const [modes, setModes] = useState<CopilotMode[]>([]);
  const [modesLoaded, setModesLoaded] = useState(false);
  const [selectedModeId, setSelectedModeId] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>(initialFields);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  // Fetch modes on mount; auto-load default if any.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<{ modes: CopilotMode[]; error?: string }>(
        "copilot-modes-loaded",
        (event) => {
          const ms = event.payload.modes ?? [];
          setModes(ms);
          setModesLoaded(true);
          // Auto-select default mode + auto-fill fields.
          const def = ms.find((m) => m.isDefault);
          if (def) {
            setSelectedModeId(def.id);
            setFields(fieldsFromMode(def));
          }
        },
      );
      void emit("wolfee-action", { type: "list-copilot-modes" });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // Listen for save responses.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<{ mode?: CopilotMode; error?: string }>(
        "copilot-mode-saved",
        (event) => {
          if (event.payload.error) {
            setErrorMsg(`Save failed: ${event.payload.error}`);
            setIsSaving(false);
            return;
          }
          if (event.payload.mode) {
            const newMode = event.payload.mode;
            setModes((prev) => {
              const idx = prev.findIndex((m) => m.id === newMode.id);
              if (idx >= 0) {
                return prev.map((m) => (m.id === newMode.id ? newMode : m));
              }
              return [...prev, newMode];
            });
            setSelectedModeId(newMode.id);
            setShowSaveForm(false);
            setSaveName("");
            setIsSaving(false);
          }
        },
      );
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, isSubmitting]);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await emit("wolfee-action", {
        type: "submit-copilot-context",
        about_user: fields.about_user.trim() || null,
        about_call: fields.about_call.trim() || null,
        objections: fields.objections.trim() || null,
        mode_used_id: selectedModeId,
      });
    } catch (err) {
      setErrorMsg(typeof err === "string" ? err : "Failed to start session");
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    void emit("wolfee-action", "cancel-copilot-context");
  };

  const handleModeSelect = (modeId: string | null) => {
    setSelectedModeId(modeId);
    if (modeId === null) {
      setFields(initialFields);
      return;
    }
    const mode = modes.find((m) => m.id === modeId);
    if (mode) setFields(fieldsFromMode(mode));
  };

  const handleSaveMode = () => {
    if (!saveName.trim()) return;
    setIsSaving(true);
    setErrorMsg(null);
    void emit("wolfee-action", {
      type: "save-copilot-mode",
      // No mode_id → create new
      name: saveName.trim(),
      context_about_user: fields.about_user.trim() || null,
      context_about_call: fields.about_call.trim() || null,
      context_objections: fields.objections.trim() || null,
    });
  };

  // Determine if fields differ from the selected mode's saved values.
  // Used to show "Save as Mode" + "Update mode" affordances only
  // when there's something to save.
  const selectedMode = selectedModeId
    ? modes.find((m) => m.id === selectedModeId) ?? null
    : null;
  const isDirty = selectedMode
    ? !fieldsAreEqual(fields, fieldsFromMode(selectedMode))
    : !fieldsAreEqual(fields, initialFields);

  return (
    <div className="h-screen w-screen bg-zinc-950 text-zinc-100 flex flex-col p-6 gap-4 overflow-y-auto">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Set up this Copilot session</h1>
        <p className="text-xs text-zinc-400">
          Pick a saved Mode or paste fresh context. All fields optional.
        </p>
      </header>

      {/* Mode selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-300">
          Mode
        </label>
        <div className="relative">
          <select
            value={selectedModeId ?? ""}
            onChange={(e) =>
              handleModeSelect(e.target.value === "" ? null : e.target.value)
            }
            disabled={isSubmitting || !modesLoaded}
            className="appearance-none w-full rounded-md border border-white/10 bg-zinc-900 pl-3 pr-9 py-2 text-sm text-zinc-100 focus:border-copilot-accent focus:outline-none disabled:opacity-50"
          >
            <option value="">
              (No mode — paste manually)
            </option>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.isDefault ? "★ " : ""}
                {m.name}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
        </div>
        {selectedMode?.description && (
          <p className="text-[11px] text-zinc-500 mt-0.5 px-0.5">
            {selectedMode.description}
          </p>
        )}
      </div>

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

      {/* Save as Mode — only when fields are dirty */}
      {isDirty && !showSaveForm && (
        <button
          type="button"
          onClick={() => setShowSaveForm(true)}
          disabled={isSubmitting}
          className="self-start inline-flex items-center gap-1.5 text-xs text-copilot-accent hover:text-cyan-300 transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          Save as a new Mode
        </button>
      )}
      {showSaveForm && (
        <div className="border border-white/10 bg-zinc-900/40 rounded-md p-3 flex items-center gap-2">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value.slice(0, 100))}
            placeholder="Mode name (e.g. Clinic Discovery)"
            disabled={isSaving}
            className="flex-1 bg-zinc-900 border border-white/10 rounded-md px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-copilot-accent focus:outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSaveMode}
            disabled={!saveName.trim() || isSaving}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-copilot-accent text-zinc-950 rounded-md disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Star className="w-3 h-3" />}
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSaveForm(false);
              setSaveName("");
            }}
            disabled={isSaving}
            className="text-xs text-zinc-500 hover:text-zinc-300 px-2"
          >
            Cancel
          </button>
        </div>
      )}

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
