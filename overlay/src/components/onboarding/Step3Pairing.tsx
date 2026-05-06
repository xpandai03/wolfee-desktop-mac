import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";

import {
  StepLayout,
  PrimaryButton,
  SecondaryButton,
  TextLink,
} from "./StepLayout";
import { Step3Illustration } from "./illustrations";
import { WIZARD_COPY, WIZARD_TOTAL_STEPS } from "./wizardCopy";
import type { Action, OverlayState } from "@/state/types";

/**
 * Sub-prompt 6.0 — Step 3 (link account) is the only step with
 * external state coupling. It polls Rust for auth status every 2s
 * while open; when paired flips true, dispatches PAIRING_COMPLETE
 * which auto-advances to Step 4 (1.5s grace shows "Already linked"
 * confirmation).
 *
 * Polling stops on any of: paired success, user navigates away from
 * step 3, 5-min timeout. Timeout shows "Took too long?" CTA.
 */

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1_000;
const SUCCESS_DELAY_MS = 1_500;

interface Props {
  /** Reserved for surfacing reducer-side pairing state in V2. The
   * polling state today lives in component-local state since it's
   * step-scoped. */
  state: OverlayState;
  dispatch: Dispatch<Action>;
  onEmitAction: (action: string | object) => void;
  onSkip: () => void;
  onPrev: () => void;
  onAdvance: () => void;
}

export function Step3Pairing({
  state: _state,
  dispatch,
  onEmitAction,
  onSkip,
  onPrev,
  onAdvance,
}: Props) {
  const [linkClicked, setLinkClicked] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [pairedAtMs, setPairedAtMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Listen for auth-status replies from Rust. Setup once on mount.
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<{ paired: boolean; user_id: string | null }>(
        "auth-status-loaded",
        (event) => {
          if (cancelled) return;
          if (event.payload.paired) {
            // Mark paired locally — wizard will auto-advance after grace
            setPairedAtMs(Date.now());
            dispatch({ type: "SET_PAIRING_POLLING", polling: false });
          }
        },
      );
      if (cancelled) {
        u();
      } else {
        unlistenFn = u;
      }
    })();
    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [dispatch]);

  // Kick off a single status check on mount so we render the right
  // initial state (already-linked users see the success path).
  useEffect(() => {
    onEmitAction({ type: "request-auth-status" });
  }, [onEmitAction]);

  // Poll every 2s while waiting. The polling flag in reducer state is
  // independent of linkClicked — we always poll while on Step 3 in
  // case the user paired through some other path (tray "Link with
  // Wolfee…" works in parallel).
  useEffect(() => {
    if (pairedAtMs !== null) return; // already paired, no need to poll
    if (timedOut) return;
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    dispatch({ type: "SET_PAIRING_POLLING", polling: true });
    const id = window.setInterval(() => {
      const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
      if (elapsed >= TIMEOUT_MS) {
        setTimedOut(true);
        dispatch({ type: "SET_PAIRING_POLLING", polling: false });
        window.clearInterval(id);
        return;
      }
      onEmitAction({ type: "request-auth-status" });
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      dispatch({ type: "SET_PAIRING_POLLING", polling: false });
    };
  }, [pairedAtMs, timedOut, dispatch, onEmitAction]);

  // Auto-advance after the success-grace period.
  useEffect(() => {
    if (pairedAtMs === null) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "PAIRING_COMPLETE" });
      onEmitAction({ type: "mark-onboarding-step", step: 4 });
    }, SUCCESS_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [pairedAtMs, dispatch, onEmitAction]);

  const handleOpenLink = () => {
    setLinkClicked(true);
    setTimedOut(false);
    startedAtRef.current = Date.now();
    onEmitAction("link-account");
  };

  const handleRetry = () => {
    setTimedOut(false);
    setLinkClicked(false);
    startedAtRef.current = null;
    setPairedAtMs(null);
  };

  // Body: shifts based on state — initial CTA, polling, success, timeout.
  let body: React.ReactNode;
  let primaryCta: React.ReactNode;
  let secondaryCta: React.ReactNode;

  if (pairedAtMs !== null) {
    body = (
      <div>
        <p className="text-emerald-300 font-medium">
          {WIZARD_COPY.step3.alreadyLinkedText("")}
        </p>
      </div>
    );
    primaryCta = null;
    secondaryCta = null;
  } else if (timedOut) {
    body = (
      <div>
        <p>{WIZARD_COPY.step3.body}</p>
        <p className="mt-3 text-amber-300 text-[12px]">
          {WIZARD_COPY.step3.timeoutText}
        </p>
      </div>
    );
    primaryCta = (
      <PrimaryButton onClick={handleRetry}>
        {WIZARD_COPY.step3.timeoutCta}
      </PrimaryButton>
    );
    secondaryCta = (
      <SecondaryButton onClick={onAdvance}>
        {WIZARD_COPY.step3.secondaryCta}
      </SecondaryButton>
    );
  } else if (linkClicked) {
    body = (
      <div>
        <p>{WIZARD_COPY.step3.body}</p>
        <div className="mt-3 inline-flex items-center gap-2 text-[12px] text-zinc-400">
          <span
            className="inline-block w-3 h-3 rounded-full border-2 border-copilot-accent border-t-transparent animate-spin"
            aria-hidden
          />
          <span>{WIZARD_COPY.step3.waitingText}</span>
        </div>
      </div>
    );
    primaryCta = (
      <SecondaryButton onClick={onAdvance}>
        {WIZARD_COPY.step3.secondaryCta}
      </SecondaryButton>
    );
    secondaryCta = <TextLink onClick={onPrev}>← Back</TextLink>;
  } else {
    body = <p>{WIZARD_COPY.step3.body}</p>;
    primaryCta = (
      <PrimaryButton onClick={handleOpenLink}>
        {WIZARD_COPY.step3.primaryCta}
      </PrimaryButton>
    );
    secondaryCta = (
      <SecondaryButton onClick={onAdvance}>
        {WIZARD_COPY.step3.secondaryCta}
      </SecondaryButton>
    );
  }

  return (
    <StepLayout
      step={3}
      totalSteps={WIZARD_TOTAL_STEPS}
      illustration={<Step3Illustration />}
      headline={WIZARD_COPY.step3.headline}
      body={body}
      primaryCta={primaryCta}
      secondaryCta={secondaryCta}
      onSkip={onSkip}
    />
  );
}
