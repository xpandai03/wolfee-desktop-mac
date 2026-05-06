import { AnimatePresence } from "framer-motion";
import type { Dispatch } from "react";

import {
  StepLayout,
  PrimaryButton,
  SecondaryButton,
  TextLink,
} from "./StepLayout";
import {
  Step1Illustration,
  Step2Illustration,
  Step5Illustration,
  Step6Illustration,
} from "./illustrations";
import { Step3Pairing } from "./Step3Pairing";
import { Step4Permissions } from "./Step4Permissions";
import { WIZARD_COPY, WIZARD_TOTAL_STEPS, WOLFEE_MODES_URL } from "./wizardCopy";
import type { Action, OverlayState } from "@/state/types";

/**
 * Sub-prompt 6.0 — top-level onboarding wizard. Renders inside
 * ExpandedPanel via bodyOverride. The wizard owns step content (1, 2,
 * 5, 6 inline; 3 + 4 delegated to dedicated components since they
 * have side-effects: polling and permission checks).
 *
 * Lifecycle:
 *   - Mount fires when CopilotOverlay's onboardingOpen flips true
 *   - Continue → ADVANCE_STEP. Persist via mark-onboarding-step.
 *   - Skip tour / Get started → SKIP_TOUR / COMPLETE_ONBOARDING.
 *     Persist via mark-onboarding-completed.
 *   - The wizard never reaches outside the bodyOverride bounds. The
 *     Strip stays visible above it (Phase 6 PermissionModal still
 *     wins precedence inside CopilotOverlay).
 */

interface Props {
  state: OverlayState;
  dispatch: Dispatch<Action>;
  /** Wraps `emit` from @tauri-apps/api/event so the wizard doesn't
   * need to import Tauri APIs directly — keeps the unit-test surface
   * narrow and lets dev-mode mocks intercept. */
  onEmitAction: (action: string | object) => void;
}

export function OnboardingWizard({ state, dispatch, onEmitAction }: Props) {
  const step = state.onboardingStep;

  const handleAdvance = () => {
    if (step >= WIZARD_TOTAL_STEPS) {
      handleComplete();
      return;
    }
    dispatch({ type: "ADVANCE_STEP" });
    onEmitAction({ type: "mark-onboarding-step", step: step + 1 });
  };

  const handlePrev = () => {
    dispatch({ type: "PREV_STEP" });
    onEmitAction({ type: "mark-onboarding-step", step: Math.max(step - 1, 1) });
  };

  const handleSkip = () => {
    dispatch({ type: "SKIP_TOUR" });
    onEmitAction({ type: "mark-onboarding-completed" });
  };

  const handleComplete = () => {
    dispatch({ type: "COMPLETE_ONBOARDING" });
    onEmitAction({ type: "mark-onboarding-completed" });
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {step === 1 && (
        <StepLayout
          key="s1"
          step={1}
          totalSteps={WIZARD_TOTAL_STEPS}
          illustration={<Step1Illustration />}
          headline={WIZARD_COPY.step1.headline}
          body={<p>{WIZARD_COPY.step1.body}</p>}
          primaryCta={
            <PrimaryButton onClick={handleAdvance}>Continue</PrimaryButton>
          }
          onSkip={handleSkip}
        />
      )}

      {step === 2 && (
        <StepLayout
          key="s2"
          step={2}
          totalSteps={WIZARD_TOTAL_STEPS}
          illustration={<Step2Illustration />}
          headline={WIZARD_COPY.step2.headline}
          body={
            <div>
              <p className="mb-3">{WIZARD_COPY.step2.body}</p>
              <ul className="grid grid-cols-3 gap-2 text-left">
                {WIZARD_COPY.step2.phases.map((p) => (
                  <li
                    key={p.label}
                    className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2"
                  >
                    <div className="text-base">{p.icon}</div>
                    <div className="mt-0.5 text-[12px] font-semibold text-zinc-100">
                      {p.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-400 leading-tight">
                      {p.desc}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          }
          primaryCta={
            <PrimaryButton onClick={handleAdvance}>Continue</PrimaryButton>
          }
          secondaryCta={
            <TextLink onClick={handlePrev}>← Back</TextLink>
          }
          onSkip={handleSkip}
        />
      )}

      {step === 3 && (
        <Step3Pairing
          key="s3"
          state={state}
          dispatch={dispatch}
          onEmitAction={onEmitAction}
          onSkip={handleSkip}
          onPrev={handlePrev}
          onAdvance={handleAdvance}
        />
      )}

      {step === 4 && (
        <Step4Permissions
          key="s4"
          state={state}
          dispatch={dispatch}
          onEmitAction={onEmitAction}
          onSkip={handleSkip}
          onPrev={handlePrev}
          onAdvance={handleAdvance}
        />
      )}

      {step === 5 && (
        <StepLayout
          key="s5"
          step={5}
          totalSteps={WIZARD_TOTAL_STEPS}
          illustration={<Step5Illustration />}
          headline={WIZARD_COPY.step5.headline}
          body={<p>{WIZARD_COPY.step5.body}</p>}
          primaryCta={
            <PrimaryButton
              onClick={() => {
                onEmitAction({
                  type: "open-external-url",
                  url: WOLFEE_MODES_URL,
                });
                handleAdvance();
              }}
            >
              {WIZARD_COPY.step5.primaryCta}
            </PrimaryButton>
          }
          secondaryCta={
            <SecondaryButton onClick={handleAdvance}>
              {WIZARD_COPY.step5.secondaryCta}
            </SecondaryButton>
          }
          onSkip={handleSkip}
        />
      )}

      {step === 6 && (
        <StepLayout
          key="s6"
          step={6}
          totalSteps={WIZARD_TOTAL_STEPS}
          illustration={<Step6Illustration />}
          headline={WIZARD_COPY.step6.headline}
          body={
            <div>
              <p className="mb-3">{WIZARD_COPY.step6.body}</p>
              <ul className="space-y-1.5 text-left max-w-[320px] mx-auto">
                {WIZARD_COPY.step6.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[12px] text-zinc-300"
                  >
                    <span className="text-copilot-accent mt-0.5">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          }
          primaryCta={
            <PrimaryButton onClick={handleComplete}>
              {WIZARD_COPY.step6.primaryCta}
            </PrimaryButton>
          }
          hideSkip
          onSkip={handleSkip}
        />
      )}
    </AnimatePresence>
  );
}
