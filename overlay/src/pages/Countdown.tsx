//! 3-2-1 countdown overlay (recorder — iteration 4).
//!
//! Rendered into a centered, content-protected window (`#/countdown`)
//! that Rust opens for ~3 s before capture starts and then destroys.
//! Purely visual — the actual capture timing is driven by Rust.

import { useEffect, useState } from "react";

export function Countdown() {
  const [n, setN] = useState(3);

  useEffect(() => {
    const t1 = window.setTimeout(() => setN(2), 1000);
    const t2 = window.setTimeout(() => setN(1), 2000);
    const t3 = window.setTimeout(() => setN(0), 3000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen items-center justify-center font-sans">
      <div className="flex h-[232px] w-[232px] flex-col items-center justify-center rounded-full bg-black/72 ring-1 ring-white/10 backdrop-blur-sm">
        {n > 0 ? (
          <span
            className="font-bold leading-none text-white tabular-nums"
            style={{ fontSize: 132 }}
          >
            {n}
          </span>
        ) : (
          <span className="text-[22px] font-semibold tracking-wide text-white">Recording…</span>
        )}
      </div>
    </div>
  );
}

export default Countdown;
