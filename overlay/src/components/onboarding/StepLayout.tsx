import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Sub-prompt 6.0 — shared frame for every wizard step.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │                                          │
 *   │            [Illustration SVG]            │
 *   │                                          │
 *   │              Step Headline               │
 *   │      One-to-three-sentence body          │
 *   │                                          │
 *   │           [Primary CTA button]           │
 *   │           [Secondary CTA link]           │
 *   │                                          │
 *   ├─── footer ──────────────────────────────┤
 *   │ Step N / 6                  Skip tour → │
 *   └─────────────────────────────────────────┘
 *
 * Children own the body content (headline, copy, CTAs). Layout owns
 * the frame, illustration slot, step counter, and Skip-tour link so
 * every step has identical chrome.
 */

export interface StepLayoutProps {
  step: number;
  totalSteps: number;
  illustration: React.ReactNode;
  headline: string;
  body: React.ReactNode;
  primaryCta?: React.ReactNode;
  secondaryCta?: React.ReactNode;
  /** When true, the Skip-tour link is hidden (used on the final step
   * where Skip is replaced by Complete). */
  hideSkip?: boolean;
  onSkip: () => void;
  /** Footer back arrow. Omit on the first step (or any state where
   * "back" has no destination) — the arrow renders disabled so the
   * footer layout stays stable. */
  onBack?: () => void;
  /** Footer forward arrow. Always-available escape hatch independent
   * of the big body CTAs. Important on Step 3's "Already linked.
   * Continuing…" state where the body shows no clickable control
   * while the 1.5s auto-advance is pending — without this arrow the
   * user has no way to manually proceed if the auto-advance is slow
   * or stalls. */
  onNext?: () => void;
}

export function StepLayout({
  step,
  totalSteps,
  illustration,
  headline,
  body,
  primaryCta,
  secondaryCta,
  hideSkip,
  onSkip,
  onBack,
  onNext,
}: StepLayoutProps) {
  return (
    <motion.div
      key={`step-${step}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full h-full flex flex-col bg-zinc-950 text-zinc-100"
    >
      {/* Body — illustration + copy + CTAs, vertically centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-4 overflow-y-auto">
        <div className="flex items-center justify-center mb-4 shrink-0">
          {illustration}
        </div>
        <h1 className="text-base font-semibold tracking-tight text-center">
          {headline}
        </h1>
        <div className="mt-2 max-w-[420px] text-[13px] leading-snug text-zinc-300 text-center">
          {body}
        </div>
        {(primaryCta || secondaryCta) && (
          <div className="mt-5 w-full max-w-[320px] flex flex-col gap-2">
            {primaryCta}
            {secondaryCta}
          </div>
        )}
      </div>

      {/* Footer — step counter + arrow nav + Skip-tour. The arrows
          flanking the step-dots give every step an always-clickable
          ←/→ chrome path that's independent of whichever body CTAs a
          step happens to render. Crucially this means Step 3's
          paired ("Already linked. Continuing…") state always has a
          forward escape hatch even before its 1.5s auto-advance fires. */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-white/5 text-[11px] text-zinc-500">
        <span aria-label={`Step ${step} of ${totalSteps}`}>
          Step {step} / {totalSteps}
        </span>
        <div className="flex items-center gap-2">
          <FooterArrow
            direction="back"
            onClick={onBack}
            ariaLabel="Previous step"
          />
          <StepDots current={step} total={totalSteps} />
          <FooterArrow
            direction="next"
            onClick={onNext}
            ariaLabel="Next step"
          />
        </div>
        {!hideSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="cursor-pointer hover:text-zinc-300 transition-colors"
          >
            Skip tour →
          </button>
        ) : (
          <span className="invisible">Skip tour →</span>
        )}
      </div>
    </motion.div>
  );
}

function FooterArrow({
  direction,
  onClick,
  ariaLabel,
}: {
  direction: "back" | "next";
  onClick?: () => void;
  ariaLabel: string;
}) {
  const disabled = !onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center justify-center w-5 h-5 rounded text-[13px] leading-none transition-colors",
        disabled
          ? "text-zinc-700 cursor-not-allowed"
          : "text-zinc-400 hover:text-zinc-100 hover:bg-white/5 cursor-pointer",
      )}
    >
      {direction === "back" ? "←" : "→"}
    </button>
  );
}

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }).map((_, i) => {
        const filled = i + 1 <= current;
        return (
          <span
            key={i}
            className={cn(
              "w-1.5 h-1.5 rounded-full transition-colors",
              filled ? "bg-copilot-accent" : "bg-zinc-700",
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * Standard CTA button styles used inside StepLayout. Exported so step
 * components can compose primary/secondary CTAs without duplicating
 * Tailwind classes.
 */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-lg bg-white/95 px-3 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-copilot-accent/60 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60 cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}

export function TextLink({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}
