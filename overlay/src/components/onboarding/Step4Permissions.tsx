import { useEffect } from "react";
import type { Dispatch } from "react";

import { StepLayout, PrimaryButton, TextLink } from "./StepLayout";
import { Step4Illustration } from "./illustrations";
import { WIZARD_COPY, WIZARD_TOTAL_STEPS } from "./wizardCopy";
import type { Action, OverlayState, PermissionStatus } from "@/state/types";

/**
 * Sub-prompt 6.0 — Step 4 (permissions). Reads silent preflight from
 * Rust (AVCaptureDevice authorizationStatus + ScreenCaptureAccess
 * preflight) every 5s while open + once on mount. The "Open System
 * Settings" CTAs use the existing wolfee-action handlers
 * `open-system-settings-microphone` / `open-system-settings-screen-recording`.
 *
 * No user-prompting probes here — those happen during session start
 * (sub-prompt 2's path). The wizard only inspects the current TCC
 * state so we can render a status indicator without nagging users.
 */

const RECHECK_INTERVAL_MS = 5_000;

interface Props {
  state: OverlayState;
  dispatch: Dispatch<Action>;
  onEmitAction: (action: string | object) => void;
  onSkip: () => void;
  onPrev: () => void;
  onAdvance: () => void;
}

export function Step4Permissions({
  state,
  dispatch: _dispatch,
  onEmitAction,
  onSkip,
  onPrev,
  onAdvance,
}: Props) {
  const status = state.onboardingPermissionStatus;

  // Mount + 5s recheck while on this step. The Rust side replies via
  // permission-status-loaded which CopilotOverlay's listener dispatches
  // to SET_PERMISSION_STATUS — the reducer side updates. Component
  // here just triggers + reads.
  useEffect(() => {
    onEmitAction({ type: "request-permission-status" });
    const id = window.setInterval(() => {
      onEmitAction({ type: "request-permission-status" });
    }, RECHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [onEmitAction]);

  const bothGranted = status.mic === "granted" && status.screen === "granted";

  return (
    <StepLayout
      step={4}
      totalSteps={WIZARD_TOTAL_STEPS}
      illustration={<Step4Illustration />}
      headline={WIZARD_COPY.step4.headline}
      body={
        <div>
          <p>{WIZARD_COPY.step4.body}</p>
          <ul className="mt-4 max-w-[280px] mx-auto text-left space-y-2">
            <PermissionRow
              label={WIZARD_COPY.step4.micLabel}
              status={status.mic}
              onOpenSettings={() =>
                onEmitAction(WIZARD_COPY.step4.micDeeplinkAction)
              }
            />
            <PermissionRow
              label={WIZARD_COPY.step4.screenLabel}
              status={status.screen}
              onOpenSettings={() =>
                onEmitAction(WIZARD_COPY.step4.screenDeeplinkAction)
              }
            />
          </ul>
          <div className="mt-3">
            <TextLink
              onClick={() =>
                onEmitAction({ type: "request-permission-status" })
              }
            >
              {WIZARD_COPY.step4.recheckCta}
            </TextLink>
          </div>
        </div>
      }
      primaryCta={
        <PrimaryButton onClick={onAdvance}>
          {bothGranted ? "Continue" : "Continue anyway"}
        </PrimaryButton>
      }
      secondaryCta={
        <div className="flex items-center justify-between">
          <TextLink onClick={onPrev}>← Back</TextLink>
          <TextLink onClick={onAdvance}>
            {WIZARD_COPY.step4.secondaryCta}
          </TextLink>
        </div>
      }
      onSkip={onSkip}
    />
  );
}

function PermissionRow({
  label,
  status,
  onOpenSettings,
}: {
  label: string;
  status: PermissionStatus | null;
  onOpenSettings: () => void;
}) {
  const granted = status === "granted";
  const displayText =
    status === null
      ? WIZARD_COPY.step4.statusLoading
      : status === "granted"
        ? WIZARD_COPY.step4.statusGranted
        : status === "denied"
          ? WIZARD_COPY.step4.statusDenied
          : WIZARD_COPY.step4.statusUndetermined;
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <span className="text-[13px] text-zinc-200 font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={
            granted
              ? "text-[12px] text-emerald-300"
              : status === null
                ? "text-[12px] text-zinc-500"
                : "text-[12px] text-amber-300"
          }
        >
          {displayText}
        </span>
        {!granted && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-[11px] text-copilot-accent hover:text-copilot-accent/80 cursor-pointer underline underline-offset-2"
          >
            Open
          </button>
        )}
      </div>
    </li>
  );
}
