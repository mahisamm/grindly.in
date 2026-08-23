"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that rolls up to its value on arrival — "₹1,890", "20.6%", "4500"
 * all work: the first run of digits is animated, the prefix, suffix and
 * grouping are kept. The server renders the FINAL text (so there is no
 * hydration mismatch and no layout shift), and the roll starts only after
 * hydration. Under prefers-reduced-motion the number simply stands.
 */
export function CountUp({ text, duration = 700 }: { text: string; duration?: number }) {
  const [shown, setShown] = useState(text);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    // Nothing to roll (no digits, or reduced motion): the final text is
    // already what was rendered on the server, so there is nothing to set.
    const m = text.match(/(-?\d[\d,]*)(\.\d+)?/);
    if (!m) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const before = text.slice(0, m.index);
    const after = text.slice((m.index ?? 0) + m[0].length);
    const target = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
    const decimals = m[2] ? m[2].length - 1 : 0;
    const grouped = m[1].includes(",");
    const fmt = (v: number) => {
      const fixed = v.toFixed(decimals);
      if (!grouped) return fixed;
      const [int, frac] = fixed.split(".");
      // en-IN style grouping mirrors what the server printed for rupees;
      // plain thousands for everything else — whichever the text used.
      const groupedInt = /\d,\d\d,\d\d\d/.test(m[1])
        ? Number(int).toLocaleString("en-IN")
        : Number(int).toLocaleString("en-US");
      return frac ? `${groupedInt}.${frac}` : groupedInt;
    };
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(`${before}${fmt(target * eased)}${after}`);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else setShown(text);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [text, duration]);

  return <span className="tabular-nums">{shown}</span>;
}
