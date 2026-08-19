"use client";

import { useEffect, useRef } from "react";

/**
 * A slow field of ink specks behind the marketing pages.
 *
 * WHERE IT IS NOT: anywhere inside /app. A moving background under a readiness
 * report is a distraction while somebody is reading a list of things wrong with
 * their resume, and it is a permanent draw on a phone battery during the one
 * task this product exists for. This is a first-impression surface — the
 * landing page and the sign-in panel — and it stops at the door.
 *
 * WHY CANVAS AND NOT A LIBRARY. Motion (motion.dev) is very good at what it
 * does — springs, layout transitions, scroll linkage — and none of that is
 * this. A per-frame simulation of eighty points is a `requestAnimationFrame`
 * loop and some arithmetic; routing it through an animation library would add a
 * dependency to the client bundle of a landing page in order to do the one
 * thing the library does not help with. The reveal-on-scroll and press
 * behaviours the rest of the site uses are already CSS transitions driven by an
 * IntersectionObserver, which is the same reasoning applied earlier.
 *
 * WHY IT LOOKS LIKE THIS. The site is warm paper, vermilion and hard shadows —
 * a print aesthetic. The default particle background of the last ten years is a
 * cyan constellation on near-black, and dropping one here would look like a
 * different website showing through. So: ink at two to six percent, a few
 * specks in the brand vermilion, a link drawn only between genuinely close
 * neighbours, and everything slow enough that you notice it on the second look
 * rather than the first.
 *
 * Four things it has to get right, none of which are visible when they work:
 *
 *   REDUCED MOTION. One static frame, no loop, no pointer tracking. The texture
 *   survives; the movement does not. Drawing nothing at all would be the easy
 *   reading of the preference and the wrong one — the user asked for less
 *   motion, not a blanker page.
 *
 *   THE THEME. Colours are read from the CSS custom properties rather than
 *   hard-coded, and re-read when the theme changes, because `data-theme` flips
 *   under a running canvas and a canvas does not inherit anything.
 *
 *   A HIDDEN TAB. The loop stops on `visibilitychange`. A background tab
 *   animating a canvas is a laptop fan.
 *
 *   THE POINTER. `pointer-events: none`, always. This sits under every link on
 *   the page and must never be the thing that swallowed a click.
 */

type Speck = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Offset from the resting position, from the pointer push. Eases back to 0. */
  ox: number;
  oy: number;
  accent: boolean;
};

/**
 * `#17140f` or `rgb(23 20 15)` — whatever the token happens to hold — as rgb.
 *
 * Exported for its test. It reads a value written by a human in a stylesheet,
 * so it has to survive the three notations the palette might legitimately be
 * rewritten in, plus the leading space `getComputedStyle` returns for a custom
 * property. Getting it wrong is invisible: the field draws in the fallback
 * colour and looks intentional.
 */
export function toRgb(value: string, fallback: [number, number, number]): [number, number, number] {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  // Anchored on `rgb(`, and NOT on "three numbers in a string". Pulling the
  // first three numbers out of anything was the first version, and it read
  // `oklch(0.2 0.02 60)` as the colour rgb(0.2, 0.02, 60) — a near-black speck
  // on a near-black page, silently, with no error anywhere. Percentages are
  // refused for the same reason rather than being read as 0-255.
  const rgb = value.trim().match(/^rgba?\(([^)]*)\)$/i);
  if (rgb && !rgb[1].includes("%")) {
    const nums = rgb[1].match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 3) {
      const channels = nums.slice(0, 3).map(Number);
      if (channels.every((n) => n >= 0 && n <= 255)) {
        return [channels[0], channels[1], channels[2]];
      }
    }
  }
  return fallback;
}

export function ParticleField({
  className = "",
  /**
   * Which end of the palette the specks are drawn from.
   *
   * `ink` for the paper-coloured pages. `paper` for a surface that is itself
   * painted `var(--ink)` — the sign-in panel — where ink specks on ink are a
   * canvas doing arithmetic for nobody. Both tokens invert with the theme, so
   * naming the token is enough; neither needs a light and a dark value here.
   */
  tone = "ink",
}: {
  className?: string;
  tone?: "ink" | "paper";
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let specks: Speck[] = [];
    let frame = 0;
    let running = true;
    // Off-screen until the pointer has actually been somewhere, so the field is
    // not pushed away from the top-left corner before anyone has moved a mouse.
    let pointerX = -9999;
    let pointerY = -9999;

    let ink: [number, number, number] = tone === "paper" ? [242, 236, 225] : [23, 20, 15];
    let accent: [number, number, number] = [227, 64, 42];

    function readTheme() {
      const styles = getComputedStyle(document.documentElement);
      ink = toRgb(styles.getPropertyValue(tone === "paper" ? "--paper" : "--ink"), ink);
      accent = toRgb(styles.getPropertyValue("--vermilion"), accent);
    }

    function layout() {
      const rect = canvas!.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      // Capped at 2. A phone reporting 3 or 4 triples the fill cost of every
      // frame for a texture nobody can resolve at that density anyway.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Scaled by the square root of the area, not by the area: density is what
      // the eye reads, and a count linear in area puts thirteen specks on a
      // phone and four hundred on a desktop.
      const count = Math.max(14, Math.min(72, Math.round(Math.sqrt(width * height) / 16)));
      specks = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // Slow. A full traverse of a laptop screen takes something like three
        // minutes, which is the difference between texture and decoration.
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: 0.9 + Math.random() * 1.5,
        ox: 0,
        oy: 0,
        // Roughly one in seven, so the brand colour reads as an occurrence
        // rather than as a colour scheme.
        accent: Math.random() < 0.14,
      }));
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);

      // Links first, so a speck always sits on top of its own threads.
      const linkDistance = 118;
      const linkSq = linkDistance * linkDistance;
      for (let i = 0; i < specks.length; i++) {
        const a = specks[i];
        const ax = a.x + a.ox;
        const ay = a.y + a.oy;
        for (let j = i + 1; j < specks.length; j++) {
          const b = specks[j];
          const dx = ax - (b.x + b.ox);
          const dy = ay - (b.y + b.oy);
          const d2 = dx * dx + dy * dy;
          if (d2 > linkSq) continue;
          // Fades to nothing at the threshold rather than popping in and out,
          // which is what a hard cutoff looks like on a field that is moving.
          const alpha = (1 - d2 / linkSq) * 0.055;
          ctx!.strokeStyle = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${alpha})`;
          ctx!.lineWidth = 0.7;
          ctx!.beginPath();
          ctx!.moveTo(ax, ay);
          ctx!.lineTo(b.x + b.ox, b.y + b.oy);
          ctx!.stroke();
        }
      }

      for (const s of specks) {
        const [r, g, b] = s.accent ? accent : ink;
        ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${s.accent ? 0.3 : 0.16})`;
        ctx!.beginPath();
        ctx!.arc(s.x + s.ox, s.y + s.oy, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function step() {
      if (!running) return;
      const pushRadius = 130;
      const pushSq = pushRadius * pushRadius;

      for (const s of specks) {
        s.x += s.vx;
        s.y += s.vy;
        // Wrapped, not bounced. A bounce off an invisible wall draws attention
        // to the wall.
        if (s.x < -8) s.x = width + 8;
        if (s.x > width + 8) s.x = -8;
        if (s.y < -8) s.y = height + 8;
        if (s.y > height + 8) s.y = -8;

        const dx = s.x + s.ox - pointerX;
        const dy = s.y + s.oy - pointerY;
        const d2 = dx * dx + dy * dy;
        if (d2 < pushSq && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const force = (1 - d / pushRadius) * 1.5;
          s.ox += (dx / d) * force;
          s.oy += (dy / d) * force;
        }
        // Eased home every frame. The displacement is a separate quantity from
        // the drift so the field returns to the arrangement it had rather than
        // being permanently ploughed by the cursor.
        s.ox *= 0.92;
        s.oy *= 0.92;
      }

      draw();
      frame = requestAnimationFrame(step);
    }

    function start() {
      if (reduced || frame) return;
      running = true;
      frame = requestAnimationFrame(step);
    }

    function stop() {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    function onPointer(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointerX = e.clientX - rect.left;
      pointerY = e.clientY - rect.top;
    }

    function onLeave() {
      pointerX = -9999;
      pointerY = -9999;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    let resizeTimer = 0;
    function onResize() {
      window.clearTimeout(resizeTimer);
      // Debounced: a desktop resize fires this continuously and each call
      // reallocates the whole field. Also covers the address-bar show/hide on
      // mobile, which reports a resize for every scroll gesture.
      resizeTimer = window.setTimeout(() => {
        layout();
        if (reduced) draw();
      }, 180);
    }

    readTheme();
    layout();

    // The theme is an attribute on <html> that a button flips, and the canvas
    // does not inherit anything, so nothing else would tell it that the ink
    // just went from near-black to near-white.
    const themeObserver = new MutationObserver(() => {
      readTheme();
      if (reduced) draw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      readTheme();
      if (reduced) draw();
    };
    scheme.addEventListener("change", onScheme);

    if (reduced) {
      draw();
    } else {
      window.addEventListener("pointermove", onPointer, { passive: true });
      window.addEventListener("pointerleave", onLeave, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      start();
    }
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      stop();
      window.clearTimeout(resizeTimer);
      themeObserver.disconnect();
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tone]);

  return <canvas ref={ref} aria-hidden className={`particle-field ${className}`} />;
}
