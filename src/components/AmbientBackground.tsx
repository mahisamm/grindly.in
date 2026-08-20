"use client";

import { useEffect } from "react";
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from "motion/react";

/**
 * The signed-in pages' ambient background: two blurred vermilion washes that
 * drift on their own (CSS, see `.ambient-*` in globals) and lean a few pixels
 * toward the pointer on a desktop or with the phone's tilt where the browser
 * offers orientation events without a permission prompt.
 *
 * Deliberately at the edge of noticeability. The washes sit at single-digit
 * opacity behind opaque cards, so they read as paper warmth rather than as a
 * feature — a background that competes with a readiness score would be
 * decoration at the reader's expense. Three restraints are load-bearing:
 *
 *   * `pointer-events: none` and `aria-hidden` — it can never intercept a tap
 *     and never reaches the accessibility tree.
 *   * The interactive lean is ±18px through a slack spring. Movement you track
 *     with your eyes is distraction; movement you only notice stopping is
 *     atmosphere.
 *   * `useReducedMotion` renders the static washes with no listeners at all,
 *     and the CSS drift is likewise disabled under the same media query.
 *
 * iOS fires deviceorientation only after DeviceOrientationEvent
 * .requestPermission() — which itself only works inside a user gesture. So on
 * browsers that expose it, the FIRST tap anywhere asks once; granted wires
 * the tilt, denied leaves the drift. The operator chose this trade
 * deliberately: phones with no tilt at all read as "the feature does not
 * exist", which is what beta testers reported.
 */
export function AmbientBackground({
  contain = false,
}: {
  /** Absolute within the nearest positioned ancestor instead of fixed to the
      viewport — for a pane whose siblings are opaque (the auth pages), where
      a viewport-wide layer would either vanish behind them or tint them. */
  contain?: boolean;
}) {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  // Slack on purpose: the wash arrives where the pointer was, a beat later.
  const x = useSpring(mx, { stiffness: 28, damping: 18 });
  const y = useSpring(my, { stiffness: 28, damping: 18 });
  // The second wash leans the other way, so the pair reads as depth rather
  // than as one sticker sliding around.
  const xInv = useTransform(x, (v) => v * -0.55);
  const yInv = useTransform(y, (v) => v * -0.55);

  useEffect(() => {
    if (reduce) return;
    const onPointer = (e: MouseEvent) => {
      mx.set((e.clientX / window.innerWidth - 0.5) * 36);
      my.set((e.clientY / window.innerHeight - 0.5) * 36);
    };
    // ±44px on tilt against ±18px on the pointer, and that asymmetry is the
    // fix for "there is no gyro feature": a phone's washes are smaller and
    // mostly off-canvas, so the lean that reads as atmosphere under a mouse
    // is invisible under a thumb. 22° of tilt = full lean.
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma === null || e.beta === null) return;
      mx.set(Math.max(-1, Math.min(1, e.gamma / 22)) * 44);
      my.set(Math.max(-1, Math.min(1, (e.beta - 40) / 22)) * 44);
    };
    window.addEventListener("mousemove", onPointer, { passive: true });

    // Safari on iOS gates deviceorientation behind a permission call that
    // must run inside a user gesture. The first tap anywhere asks, once;
    // everything else (Android, desktop) wires directly and the extra
    // listener never exists.
    let tiltWired = false;
    const wireTilt = () => {
      if (tiltWired) return;
      tiltWired = true;
      window.addEventListener("deviceorientation", onTilt);
    };
    type PermissionedDOE = { requestPermission?: () => Promise<string> };
    const doe = (window as unknown as { DeviceOrientationEvent?: PermissionedDOE })
      .DeviceOrientationEvent;
    let onFirstTouch: (() => void) | null = null;
    if (typeof doe?.requestPermission === "function") {
      onFirstTouch = () => {
        window.removeEventListener("touchend", onFirstTouch!);
        doe.requestPermission!()
          .then((state) => {
            if (state === "granted") wireTilt();
          })
          .catch(() => {
            /* denied or unavailable — the drift carries the background */
          });
      };
      window.addEventListener("touchend", onFirstTouch);
    } else {
      wireTilt();
    }

    return () => {
      window.removeEventListener("mousemove", onPointer);
      if (onFirstTouch) window.removeEventListener("touchend", onFirstTouch);
      if (tiltWired) window.removeEventListener("deviceorientation", onTilt);
    };
  }, [reduce, mx, my]);

  if (reduce) {
    return (
      <div aria-hidden className={contain ? "ambient ambient-contain" : "ambient"}>
        <div className="ambient-drift ambient-a" />
        <div className="ambient-drift ambient-b" />
      </div>
    );
  }

  return (
    <div aria-hidden className={contain ? "ambient ambient-contain" : "ambient"}>
      {/* Two layers per wash: the OUTER carries the CSS drift keyframes, the
          INNER carries the spring lean — both write `transform`, and on one
          element the inline value would simply overwrite the animation. */}
      <div className="ambient-drift ambient-a">
        <motion.div className="ambient-wash" style={{ x, y }} />
      </div>
      <div className="ambient-drift ambient-b">
        <motion.div className="ambient-wash" style={{ x: xInv, y: yInv }} />
      </div>
    </div>
  );
}
