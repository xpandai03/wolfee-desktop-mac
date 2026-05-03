/**
 * Three pulsing dots used while a suggestion is being generated
 * (Reasoning state, plan §6).
 *
 * Pure CSS keyframes — no JS animation overhead. Stagger via
 * `animationDelay` inline style. Each dot pulses with a 750ms
 * cycle, offset 0/250/500ms.
 */

export function ReasoningIndicator() {
  return (
    <span className="inline-flex items-center gap-1 text-zinc-400 text-sm leading-snug">
      <span className="text-[13px]">Reasoning</span>
      <span className="inline-flex items-center gap-1 ml-0.5" aria-hidden>
        <Dot delay={0} />
        <Dot delay={250} />
        <Dot delay={500} />
      </span>
    </span>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1 h-1 rounded-full bg-zinc-400 animate-pulse"
      style={{ animationDelay: `${delay}ms`, animationDuration: "750ms" }}
    />
  );
}
