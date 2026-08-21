"use client";

import { useEffect, useState } from "react";

/**
 * The two seconds of brand before the landing page — GRINDLY letters rising
 * in with the vermilion full stop landing last, then the whole curtain lifts.
 *
 * Three restraints keep it a greeting rather than an obstacle:
 *
 *   * Once per SESSION. sessionStorage, not localStorage — a returning
 *     visitor tomorrow gets the moment again, someone bouncing between pages
 *     today does not.
 *   * Skippable: any click or key lifts the curtain immediately.
 *   * prefers-reduced-motion (or blocked storage) shows nothing at all.
 *
 * It mounts hidden and appears via effect, so the server-rendered page is
 * identical for everyone and repeat visitors never get a flash of curtain.
 * The one-frame glimpse of the landing a first-timer might catch reads as
 * the page the intro is drawn over — which is what it is.
 */
export function IntroSplash() {
  const [phase, setPhase] = useState<"hidden" | "in" | "out">("hidden");

  useEffect(() => {
    try {
      if (sessionStorage.getItem("grindly:intro-seen")) return;
      sessionStorage.setItem("grindly:intro-seen", "1");
    } catch {
      return; // blocked storage: skip the theatre rather than replay it forever
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const raf = requestAnimationFrame(() => setPhase("in"));
    const lift = setTimeout(() => setPhase("out"), 1600);
    const gone = setTimeout(() => setPhase("hidden"), 2250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(lift);
      clearTimeout(gone);
    };
  }, []);

  useEffect(() => {
    if (phase !== "in") return;
    const skip = () => setPhase("out");
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    const gone = setTimeout(() => setPhase("hidden"), 2250);
    return () => {
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
      clearTimeout(gone);
    };
  }, [phase]);

  if (phase === "hidden") return null;

  return (
    <div aria-hidden className={`intro-splash ${phase === "out" ? "intro-splash--out" : ""}`}>
      <span className="intro-word font-display" aria-hidden>
        {"GRINDLY".split("").map((ch, i) => (
          <span key={i} className="intro-letter" style={{ animationDelay: `${140 + i * 70}ms` }}>
            {ch}
          </span>
        ))}
        <span className="intro-letter intro-dot" style={{ animationDelay: "680ms" }}>
          .
        </span>
      </span>
    </div>
  );
}
