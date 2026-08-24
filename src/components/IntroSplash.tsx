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
 * WHO decides it shows is not this component. The head script in layout.tsx
 * sets `data-intro` on <html> BEFORE the first paint (the same pre-paint slot
 * the theme uses), and the CSS only displays `.intro-splash` under that
 * attribute. The component itself renders the same markup for everyone,
 * server and client alike — no hydration branch (see AmbientBackground for
 * the React #418 that pattern earns) and, more to the point, no jank: the
 * old version mounted hidden and appeared via effect, so a first-time
 * visitor watched the landing paint and THEN a curtain pop over it, letters
 * starting only after hydration. Now the curtain is in the server HTML, the
 * attribute is on <html> before frame one, and the letters are already
 * rising while React is still waking up. All this effect does is end the
 * show: lift the curtain on time (or on any click/key), then take the node
 * out of the tree.
 */
export function IntroSplash() {
  const [phase, setPhase] = useState<"show" | "out" | "hidden">("show");

  useEffect(() => {
    // Not showing (repeat visit, reduced motion, blocked storage): the CSS
    // never displayed it, so removing the node is housekeeping, not a flash.
    // Deferred a tick — the initial "show" markup must survive hydration
    // untouched, and a sync setState inside an effect cascades renders.
    if (!document.documentElement.hasAttribute("data-intro")) {
      const drop = setTimeout(() => setPhase("hidden"), 0);
      return () => clearTimeout(drop);
    }
    const lift = setTimeout(() => setPhase("out"), 650);
    const skip = () => setPhase("out");
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(lift);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  useEffect(() => {
    if (phase !== "out") return;
    // Past the curtain's 0.9s lift; then the attribute goes so the CSS gate
    // closes for the rest of the session even before a soft navigation.
    const gone = setTimeout(() => {
      document.documentElement.removeAttribute("data-intro");
      setPhase("hidden");
    }, 450);
    return () => clearTimeout(gone);
  }, [phase]);

  if (phase === "hidden") return null;

  return (
    <div aria-hidden className={`intro-splash ${phase === "out" ? "intro-splash--out" : ""}`}>
      <span className="intro-word font-display" aria-hidden>
        {"GRINDLY".split("").map((ch, i) => (
          <span key={i} className="intro-letter" style={{ animationDelay: `${80 + i * 45}ms` }}>
            {ch}
          </span>
        ))}
        <span className="intro-letter intro-dot" style={{ animationDelay: "390ms" }}>
          .
        </span>
      </span>
    </div>
  );
}
