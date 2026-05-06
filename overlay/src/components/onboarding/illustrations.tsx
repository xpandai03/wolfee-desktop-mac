/**
 * Sub-prompt 6.0 — inline SVG illustrations for onboarding steps.
 *
 * Style guide:
 *  - Viewport 280x140 (uniform across steps for predictable layout)
 *  - Stroke-based, currentColor for primary, copilot-accent for highlights
 *  - 1.5 stroke weight (1.25 for fine details)
 *  - No filled shapes except subtle accent dots; no gradients
 *  - Embedded in JSX so iteration doesn't require asset bundling
 */

interface IllProps {
  className?: string;
}

const FRAME = "w-[280px] h-[140px] text-zinc-200";

/** Step 1 — laptop with shield + microphone overlay (privacy + listening). */
export function Step1Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Laptop screen */}
      <rect x="80" y="32" width="120" height="76" rx="4" />
      {/* Laptop base */}
      <path d="M68 108 H 212 L 218 122 H 62 Z" />
      {/* Mic icon centred on screen */}
      <g
        className="text-copilot-accent"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="132" y="50" width="16" height="24" rx="8" fill="none" />
        <path d="M126 70 v 4 a 14 14 0 0 0 28 0 v -4" />
        <line x1="140" y1="88" x2="140" y2="96" />
      </g>
      {/* Shield arc above laptop suggesting privacy */}
      <path
        d="M40 36 a 14 14 0 0 1 28 0 v 14 a 14 14 0 0 1 -14 14 a 14 14 0 0 1 -14 -14 z"
        className="text-copilot-accent"
        stroke="currentColor"
        opacity="0.7"
      />
      <path
        d="M48 44 l 4 4 l 8 -8"
        className="text-copilot-accent"
        stroke="currentColor"
      />
      {/* Soundwave hint on right */}
      <g opacity="0.5">
        <path d="M226 56 q 6 14 0 28" />
        <path d="M236 48 q 10 22 0 44" />
        <path d="M246 40 q 14 30 0 60" />
      </g>
    </svg>
  );
}

/** Step 2 — three-phase flow: Listen → Suggest → Recap with arrows. */
export function Step2Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Three nodes */}
      {[40, 140, 240].map((cx) => (
        <circle key={cx} cx={cx} cy="58" r="22" />
      ))}
      {/* Mic icon in node 1 */}
      <g transform="translate(32 46)">
        <rect x="3" y="0" width="10" height="16" rx="5" />
        <path d="M0 12 v 4 a 8 8 0 0 0 16 0 v -4" />
      </g>
      {/* Chat bubble in node 2 */}
      <g transform="translate(128 48)">
        <path d="M0 4 a 4 4 0 0 1 4 -4 h 16 a 4 4 0 0 1 4 4 v 10 a 4 4 0 0 1 -4 4 h -10 l -6 6 v -6 a 4 4 0 0 1 -4 -4 z" />
      </g>
      {/* Recap clipboard in node 3 */}
      <g transform="translate(230 44)">
        <rect x="2" y="2" width="16" height="22" rx="2" />
        <line x1="6" y1="2" x2="14" y2="2" strokeWidth="3" />
        <line x1="6" y1="10" x2="14" y2="10" />
        <line x1="6" y1="15" x2="12" y2="15" />
      </g>
      {/* Arrows between nodes */}
      <path
        d="M68 58 L 112 58"
        className="text-copilot-accent"
        stroke="currentColor"
      />
      <polyline
        points="106,53 112,58 106,63"
        className="text-copilot-accent"
        stroke="currentColor"
      />
      <path
        d="M168 58 L 212 58"
        className="text-copilot-accent"
        stroke="currentColor"
      />
      <polyline
        points="206,53 212,58 206,63"
        className="text-copilot-accent"
        stroke="currentColor"
      />
      {/* Labels */}
      <g
        fill="currentColor"
        stroke="none"
        fontSize="9"
        textAnchor="middle"
        className="text-zinc-400"
      >
        <text x="40" y="100">Listen</text>
        <text x="140" y="100">Suggest</text>
        <text x="240" y="100">Recap</text>
      </g>
    </svg>
  );
}

/** Step 3 — desktop ↔ web link with chain icon. */
export function Step3Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Left: desktop laptop */}
      <rect x="20" y="36" width="80" height="50" rx="3" />
      <path d="M16 86 H 104 L 110 96 H 10 Z" />
      <text
        x="60"
        y="64"
        fill="currentColor"
        stroke="none"
        fontSize="10"
        textAnchor="middle"
        className="text-zinc-500"
      >
        Desktop
      </text>
      {/* Right: globe (web) */}
      <circle cx="220" cy="60" r="24" />
      <ellipse cx="220" cy="60" rx="24" ry="10" />
      <line x1="196" y1="60" x2="244" y2="60" />
      <line x1="220" y1="36" x2="220" y2="84" />
      <text
        x="220"
        y="106"
        fill="currentColor"
        stroke="none"
        fontSize="10"
        textAnchor="middle"
        className="text-zinc-500"
      >
        Wolfee.io
      </text>
      {/* Chain link in middle */}
      <g
        className="text-copilot-accent"
        stroke="currentColor"
        strokeWidth="1.75"
      >
        <path d="M118 56 a 10 10 0 0 0 0 20 h 12 a 10 10 0 0 0 0 -20 h -12 z" />
        <path d="M150 56 a 10 10 0 0 1 0 20 h 12 a 10 10 0 0 1 0 -20 h -12 z" />
        <line x1="138" y1="66" x2="146" y2="66" />
      </g>
    </svg>
  );
}

/** Step 4 — macOS Settings with mic + screen icons highlighted. */
export function Step4Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Settings panel */}
      <rect x="40" y="20" width="200" height="100" rx="6" />
      {/* Header bar */}
      <line x1="40" y1="36" x2="240" y2="36" />
      <circle cx="50" cy="28" r="2" fill="currentColor" />
      <circle cx="58" cy="28" r="2" fill="currentColor" />
      <circle cx="66" cy="28" r="2" fill="currentColor" />
      {/* Mic row */}
      <g transform="translate(54 50)">
        <g className="text-copilot-accent" stroke="currentColor">
          <rect x="0" y="0" width="10" height="16" rx="5" />
          <path d="M-4 12 v 2 a 9 9 0 0 0 18 0 v -2" />
        </g>
        <text
          x="24"
          y="11"
          fill="currentColor"
          stroke="none"
          fontSize="9"
          className="text-zinc-300"
        >
          Microphone
        </text>
        {/* Toggle on */}
        <rect
          x="170"
          y="2"
          width="22"
          height="12"
          rx="6"
          className="text-copilot-accent"
          stroke="currentColor"
        />
        <circle
          cx="186"
          cy="8"
          r="4"
          className="text-copilot-accent"
          fill="currentColor"
          stroke="none"
        />
      </g>
      {/* Screen row */}
      <g transform="translate(54 84)">
        <g className="text-copilot-accent" stroke="currentColor">
          <rect x="-2" y="0" width="16" height="11" rx="1" />
          <line x1="2" y1="14" x2="10" y2="14" />
        </g>
        <text
          x="24"
          y="9"
          fill="currentColor"
          stroke="none"
          fontSize="9"
          className="text-zinc-300"
        >
          Screen Recording
        </text>
        {/* Toggle on */}
        <rect
          x="170"
          y="0"
          width="22"
          height="12"
          rx="6"
          className="text-copilot-accent"
          stroke="currentColor"
        />
        <circle
          cx="186"
          cy="6"
          r="4"
          className="text-copilot-accent"
          fill="currentColor"
          stroke="none"
        />
      </g>
    </svg>
  );
}

/** Step 5 — preview of the strip + expanded panel. */
export function Step5Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Strip bar */}
      <rect x="40" y="20" width="200" height="14" rx="6" />
      {/* Status pill on strip */}
      <circle
        cx="50"
        cy="27"
        r="2"
        className="text-copilot-accent"
        fill="currentColor"
        stroke="none"
      />
      <line x1="56" y1="27" x2="80" y2="27" opacity="0.4" />
      {/* Buttons on strip */}
      <line x1="200" y1="24" x2="206" y2="30" opacity="0.4" />
      <line x1="206" y1="24" x2="200" y2="30" opacity="0.4" />
      {/* Expanded panel below */}
      <rect x="40" y="38" width="200" height="80" rx="0" />
      {/* Tab bar */}
      <line x1="40" y1="52" x2="240" y2="52" />
      <line
        x1="50"
        y1="52"
        x2="80"
        y2="52"
        className="text-copilot-accent"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Chat lines */}
      <line x1="50" y1="64" x2="160" y2="64" opacity="0.4" />
      <line x1="50" y1="72" x2="200" y2="72" opacity="0.4" />
      <line x1="50" y1="80" x2="140" y2="80" opacity="0.4" />
      {/* Input pill */}
      <rect
        x="50"
        y="96"
        width="180"
        height="14"
        rx="7"
        className="text-copilot-accent"
        stroke="currentColor"
        opacity="0.7"
      />
    </svg>
  );
}

/** Step 6 — celebratory checkmark with subtle accents. */
export function Step6Illustration({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 280 140"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${FRAME} ${className ?? ""}`}
      aria-hidden
    >
      {/* Big check circle */}
      <circle
        cx="140"
        cy="70"
        r="36"
        className="text-copilot-accent"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M122 72 l 12 12 l 24 -24"
        className="text-copilot-accent"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      {/* Subtle confetti dots */}
      <g className="text-zinc-500" fill="currentColor" stroke="none">
        <circle cx="60" cy="40" r="2" />
        <circle cx="80" cy="100" r="2" />
        <circle cx="220" cy="40" r="2" />
        <circle cx="200" cy="100" r="2" />
        <circle cx="40" cy="70" r="1.5" />
        <circle cx="240" cy="70" r="1.5" />
      </g>
      <g
        className="text-copilot-accent"
        fill="currentColor"
        stroke="none"
        opacity="0.7"
      >
        <circle cx="100" cy="30" r="2" />
        <circle cx="180" cy="30" r="2" />
        <circle cx="100" cy="110" r="2" />
        <circle cx="180" cy="110" r="2" />
      </g>
    </svg>
  );
}
