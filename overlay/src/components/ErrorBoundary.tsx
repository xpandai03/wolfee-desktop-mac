import React from "react";

/**
 * Catch-all error boundary for the overlay (added 2026-05-04 after the
 * "black screen" bug — a reducer throw was crashing the entire tree
 * silently because there was no fallback).
 *
 * Renders a minimal red-border panel with the error message so the
 * next time something throws, the user (and the engineer) sees what
 * happened instead of just a blank window.
 */

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to console for devtools; also for the bridge to Rust if
    // we ever want to forward it. Sub-prompt 7 telemetry could pipe
    // these through the existing wolfee-action channel.
    console.error("[Copilot/overlay] ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-zinc-950 text-zinc-200">
          <div className="w-full rounded-lg border border-red-500/40 bg-zinc-900 p-3">
            <p className="text-sm font-semibold text-red-400">
              Wolfee Copilot — overlay error
            </p>
            <p className="text-xs text-zinc-400 mt-1 break-words">
              {this.state.error.message || "Unknown error"}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-3 text-[11px] text-zinc-300 underline underline-offset-2 hover:text-zinc-100"
            >
              Reset
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
