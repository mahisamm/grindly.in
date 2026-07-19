"use client";

import { useEffect, useRef, useState } from "react";

/**
 * ParticleHero — the proto's living letterform, ported into the app.
 *
 * A cast (a single letter, or the full word GRINDLY) is rasterised to an
 * offscreen 2D canvas in the app's display face (Fraunces, read from the
 * `--ff-display` CSS var so it matches next/font's hashed family name). Every
 * opaque pixel becomes a 3D particle target; morphing re-samples the targets
 * and eases each particle home with a per-particle stagger. The cursor is a 3D
 * repeller that carves holes in the glyph; releasing lets it heal. Click to
 * recast. Auto-cast cycles on a timer.
 *
 * `three` is imported lazily *inside* the effect so it never touches the server
 * bundle (no SSR of WebGL) and ships in its own client chunk under the app CSP
 * (script-src 'self' — no CDN). Reduced-motion and WebGL-less clients get a
 * static poster instead.
 */

const GLYPHS = ["GRINDLY", "G", "R", "I", "N", "D", "L", "Y"] as const;
const LETTER_BTNS = ["G", "R", "I", "N", "D", "L", "Y"] as const;

export default function ParticleHero() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const posterRef = useRef<HTMLDivElement>(null);
  const glyphElRef = useRef<HTMLSpanElement>(null);
  const countElRef = useRef<HTMLSpanElement>(null);
  const stateElRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);

  // Imperative handle into the running scene, set once three has booted.
  const apiRef = useRef<{ select: (text: string) => void; setAuto: (on: boolean) => void } | null>(null);

  const [activeGlyph, setActiveGlyph] = useState<string>("GRINDLY");
  const [auto, setAuto] = useState(true);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Static poster for reduced-motion (respect the preference; skip WebGL work).
    // Media query is only knowable client-side, so this can't move to a useState
    // initializer without causing an SSR/hydration mismatch.
    if (reduceMotion) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(true);
      return;
    }

    let disposed = false;
    let cleanup = () => {};

    (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        if (!disposed) setFallback(true);
        return;
      }
      if (disposed) return;

      // ---- WebGL support / graceful fallback ----
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        if (!renderer.getContext()) throw new Error("no gl");
      } catch {
        setFallback(true);
        return;
      }

      const PALETTE = {
        ink: new THREE.Color("#17140f"),
        soft: new THREE.Color("#4a443b"),
        vermilion: new THREE.Color("#e3402a"),
      };

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
      camera.position.set(0, 0, 30);
      let targetCamZ = 30;

      // ---- resolve the display face from the CSS var (next/font hashed name) ----
      const displayFamily =
        getComputedStyle(document.documentElement).getPropertyValue("--ff-display").trim() ||
        '"Fraunces"';
      const RASTER_FONT = (size: number) => `900 ${size}px ${displayFamily}, Georgia, serif`;

      // ---- particle sampling ----
      const SAMPLE_W = 1440;
      const SAMPLE_H = 360;
      const off = document.createElement("canvas");
      off.width = SAMPLE_W;
      off.height = SAMPLE_H;
      const octx = off.getContext("2d", { willReadFrequently: true })!;
      const PLANE_W = 44;
      const WPP = PLANE_W / SAMPLE_W;

      function sampleGlyph(text: string) {
        octx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
        octx.fillStyle = "#000";
        octx.textAlign = "center";
        octx.textBaseline = "middle";
        let size = Math.round(SAMPLE_H * 0.82);
        octx.font = RASTER_FONT(size);
        const w = octx.measureText(text).width;
        const maxW = SAMPLE_W * 0.94;
        if (w > maxW) {
          size = Math.floor(size * (maxW / w));
          octx.font = RASTER_FONT(size);
        }
        octx.fillText(text, SAMPLE_W / 2, SAMPLE_H / 2 + SAMPLE_H * 0.02);

        const data = octx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
        const pts: number[] = [];
        let maxAbsX = 1,
          maxAbsY = 1;
        const step = 2;
        for (let y = 0; y < SAMPLE_H; y += step) {
          for (let x = 0; x < SAMPLE_W; x += step) {
            const a = data[(y * SAMPLE_W + x) * 4 + 3];
            if (a > 128) {
              const jx = x + (Math.random() - 0.5) * step;
              const jy = y + (Math.random() - 0.5) * step;
              const wx = (jx / SAMPLE_W - 0.5) * PLANE_W;
              const wy = -(jy / SAMPLE_H - 0.5) * (SAMPLE_H * WPP);
              pts.push(wx, wy);
              const ax = Math.abs(wx),
                ay = Math.abs(wy);
              if (ax > maxAbsX) maxAbsX = ax;
              if (ay > maxAbsY) maxAbsY = ay;
            }
          }
        }
        return { pts, maxAbsX, maxAbsY };
      }

      // ---- particle budget (scaled to card size) ----
      // Only genuinely small (phone-width) cards drop to the lighter budget; a
      // desktop hero column (~460px) keeps the full, dense 42k specimen.
      let PARTICLES = 42000;
      if (stage.clientWidth < 400) PARTICLES = 24000;

      const positions = new Float32Array(PARTICLES * 3);
      const targets = new Float32Array(PARTICLES * 3);
      const homeZ = new Float32Array(PARTICLES);
      const velocities = new Float32Array(PARTICLES * 3);
      const colors = new Float32Array(PARTICLES * 3);
      const seeds = new Float32Array(PARTICLES);

      for (let i = 0; i < PARTICLES; i++) {
        const r = 16 + Math.random() * 12;
        const th = Math.random() * Math.PI * 2;
        positions[i * 3] = Math.cos(th) * r;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 24;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 8;
        homeZ[i] = (Math.random() - 0.5) * 1.0;
        seeds[i] = Math.random();
        const roll = Math.random();
        const c = roll < 0.07 ? PALETTE.vermilion : roll < 0.32 ? PALETTE.soft : PALETTE.ink;
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

      function dotTexture() {
        const s = 64;
        const c = document.createElement("canvas");
        c.width = c.height = s;
        const g = c.getContext("2d")!;
        const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.85)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
        g.fill();
        return new THREE.CanvasTexture(c);
      }

      const dotTex = dotTexture();
      const mat = new THREE.PointsMaterial({
        size: 0.115,
        map: dotTex,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.NormalBlending,
      });

      const points = new THREE.Points(geo, mat);
      scene.add(points);

      let morphStart = 0;
      let morphing = false;
      const MORPH_MS = 1400;

      function setTargets(text: string) {
        const { pts, maxAbsX, maxAbsY } = sampleGlyph(text);
        const n = pts.length / 2;
        if (n === 0) return;
        for (let i = 0; i < PARTICLES; i++) {
          const s = (i % n) * 2;
          targets[i * 3] = pts[s];
          targets[i * 3 + 1] = pts[s + 1];
          targets[i * 3 + 2] = homeZ[i];
        }
        if (glyphElRef.current) glyphElRef.current.textContent = text.length > 1 ? "G–Y" : text;
        if (stateElRef.current) stateElRef.current.textContent = "settling";
        morphStart = performance.now();
        morphing = true;
        fitCamera(maxAbsX, maxAbsY, text.length > 1);
      }

      // Centered fit — the card frames the specimen, so no left/right float.
      function fitCamera(halfW: number, halfH: number, isWord: boolean) {
        const vFov = (camera.fov * Math.PI) / 180;
        const tanV = Math.tan(vFov / 2);
        const tanH = tanV * camera.aspect;
        const marginW = isWord ? 1.5 : 1.2;
        const marginH = 1.58;
        const zH = (halfH * marginH) / tanV;
        const zW = (halfW * marginW) / tanH;
        targetCamZ = Math.max(zH, zW, 12);
      }

      // ---- cursor as 3D repeller ----
      const pointer = new THREE.Vector2(-10, -10);
      let pointerActive = false;
      const ndc = new THREE.Vector2();
      const raycaster = new THREE.Raycaster();
      const glyphPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const cursorWorld = new THREE.Vector3(999, 999, 0);
      const REPEL_R = 3.0;
      const REPEL_STR = 2.6;

      function updateCursorWorld() {
        const rect = canvas!.getBoundingClientRect();
        ndc.x = ((pointer.x - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((pointer.y - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        raycaster.ray.intersectPlane(glyphPlane, cursorWorld);
      }

      const onPointerMove = (e: PointerEvent) => {
        pointer.set(e.clientX, e.clientY);
        pointerActive = true;
        hideHint();
      };
      const onPointerLeave = () => {
        pointerActive = false;
        cursorWorld.set(999, 999, 0);
      };
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);

      // ---- click to recast + ripple pulse ----
      let pulse = 0;
      const pulseCenter = new THREE.Vector3();
      const onClick = () => {
        updateCursorWorld();
        pulseCenter.copy(cursorWorld);
        pulse = 1;
        advance();
        hideHint();
      };
      canvas.addEventListener("click", onClick);

      // ---- cast selection + auto-cast ----
      let idx = 0;
      let autoOn = true;
      let autoTimer = performance.now();
      const AUTO_MS_LETTER = 3400;
      const AUTO_MS_WORD = 5600;

      function selectGlyph(i: number) {
        idx = (i + GLYPHS.length) % GLYPHS.length;
        setTargets(GLYPHS[idx]);
        setActiveGlyph(GLYPHS[idx]);
        autoTimer = performance.now();
      }
      function advance() {
        selectGlyph(idx + 1);
      }

      let hinted = false;
      function hideHint() {
        if (hinted) return;
        hinted = true;
        if (hintRef.current) {
          hintRef.current.style.transition = "opacity .8s";
          hintRef.current.style.opacity = "0";
        }
      }

      // ---- resize ----
      function resize() {
        const w = Math.max(stage!.clientWidth, 1);
        const h = Math.max(stage!.clientHeight, 1);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        const { maxAbsX, maxAbsY } = sampleGlyph(GLYPHS[idx]);
        fitCamera(maxAbsX, maxAbsY, GLYPHS[idx].length > 1);
      }
      const ro = new ResizeObserver(resize);
      ro.observe(stage);

      function easeInOut(t: number) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      if (countElRef.current) countElRef.current.textContent = PARTICLES.toLocaleString();
      resize();
      selectGlyph(0);

      // Expose control to the React buttons.
      apiRef.current = {
        select: (text: string) => {
          const i = GLYPHS.indexOf(text as (typeof GLYPHS)[number]);
          if (i >= 0) selectGlyph(i);
        },
        setAuto: (on: boolean) => {
          autoOn = on;
          autoTimer = performance.now();
        },
      };

      let last = performance.now();
      let idleRot = 0;
      let raf = 0;

      function tick(now: number) {
        raf = requestAnimationFrame(tick);
        if (document.hidden) {
          last = now;
          return;
        }
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;

        const camLerp = Math.min(dt * 3.2, 1);
        camera.position.z += (targetCamZ - camera.position.z) * camLerp;
        camera.lookAt(0, 0, 0);

        if (pointerActive) updateCursorWorld();

        const zoomScale = THREE.MathUtils.clamp(camera.position.z / 30, 0.7, 2.2);
        const repelR = REPEL_R * zoomScale;
        const repelR2 = repelR * repelR;

        const gp = morphing ? Math.min((now - morphStart) / MORPH_MS, 1) : 1;
        if (morphing && gp >= 1) {
          morphing = false;
          if (stateElRef.current) stateElRef.current.textContent = pointerActive ? "carving" : "cast";
        }

        const pos = geo.attributes.position.array as Float32Array;
        const cx = cursorWorld.x,
          cy = cursorWorld.y;
        const withinCursor = pointerActive && Math.abs(cx) < 60;
        let carving = false;

        for (let i = 0; i < PARTICLES; i++) {
          const ix = i * 3;
          let lp = 1;
          if (morphing) {
            const start = seeds[i] * 0.42;
            lp = easeInOut(THREE.MathUtils.clamp((gp - start) / (1 - 0.42), 0, 1));
          }

          const tx = targets[ix],
            ty = targets[ix + 1],
            tz = targets[ix + 2];
          const dx = tx - pos[ix];
          const dy = ty - pos[ix + 1];
          const dz = tz - pos[ix + 2];

          const pull = morphing ? 0.06 + 0.22 * lp : 0.2;
          velocities[ix] += dx * pull;
          velocities[ix + 1] += dy * pull;
          velocities[ix + 2] += dz * pull;

          if (withinCursor) {
            const rx = pos[ix] - cx;
            const ry = pos[ix + 1] - cy;
            const d2 = rx * rx + ry * ry;
            if (d2 < repelR2) {
              const d = Math.sqrt(d2) + 0.0001;
              const f = 1 - d / repelR;
              velocities[ix] += (rx / d) * f * REPEL_STR;
              velocities[ix + 1] += (ry / d) * f * REPEL_STR;
              velocities[ix + 2] += f * f * REPEL_STR * 1.8 * (seeds[i] > 0.5 ? 1 : -1);
              carving = true;
            }
          }

          if (pulse > 0.01) {
            const rx = pos[ix] - pulseCenter.x;
            const ry = pos[ix + 1] - pulseCenter.y;
            const d = Math.sqrt(rx * rx + ry * ry) + 0.0001;
            if (d < 10) {
              const f = pulse * (1 - d / 10) * 0.9;
              velocities[ix] += (rx / d) * f;
              velocities[ix + 1] += (ry / d) * f;
              velocities[ix + 2] += (Math.random() - 0.5) * f * 1.4;
            }
          }

          const damp = morphing ? 0.8 : 0.68;
          velocities[ix] *= damp;
          velocities[ix + 1] *= damp;
          velocities[ix + 2] *= damp * 0.96;
          pos[ix] += velocities[ix];
          pos[ix + 1] += velocities[ix + 1];
          pos[ix + 2] += velocities[ix + 2];
        }

        geo.attributes.position.needsUpdate = true;
        if (pulse > 0.01) pulse *= 0.86;

        if (!morphing && stateElRef.current) {
          stateElRef.current.textContent = carving ? "carving" : "cast";
        }

        idleRot += dt * 0.06;
        points.rotation.y = Math.sin(idleRot) * 0.045;
        points.rotation.x = Math.cos(idleRot * 0.7) * 0.02;

        const holdMs = GLYPHS[idx].length > 1 ? AUTO_MS_WORD : AUTO_MS_LETTER;
        if (autoOn && now - autoTimer > holdMs && !morphing) advance();

        renderer.render(scene, camera);
      }

      // Re-sample once the webfont is ready so the first raster is real Fraunces.
      document.fonts
        .load(`900 100px ${displayFamily}`)
        .then(() => {
          if (!disposed) selectGlyph(idx);
        })
        .catch(() => {});

      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas!.removeEventListener("pointermove", onPointerMove);
        canvas!.removeEventListener("pointerleave", onPointerLeave);
        canvas!.removeEventListener("click", onClick);
        apiRef.current = null;
        geo.dispose();
        mat.dispose();
        dotTex.dispose();
        renderer.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const pick = (g: string) => apiRef.current?.select(g);
  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    apiRef.current?.setAuto(next);
  };

  return (
    <div className="specimen-card">
      <div className="specimen-topline">
        <span className="specimen-cap">
          Now casting <span ref={glyphElRef} className="specimen-glyph">G</span>
        </span>
        <span className="specimen-cap specimen-cap--right">
          <span ref={countElRef} className="specimen-fig">42,000</span> particles ·{" "}
          <span ref={stateElRef} className="specimen-state">settling</span>
        </span>
      </div>

      <div className="specimen-stage" ref={stageRef}>
        <canvas ref={canvasRef} className="specimen-canvas" aria-hidden />
        {fallback && (
          <div ref={posterRef} className="specimen-poster" aria-hidden>
            GRINDLY
          </div>
        )}
        <p ref={hintRef} className="specimen-hint">
          move over the letters to carve them · click to recast
        </p>
      </div>

      <div className="specimen-controls" role="group" aria-label="Choose the letter">
        {LETTER_BTNS.map((g) => (
          <button
            key={g}
            type="button"
            className={`glyph-btn${activeGlyph === g ? " is-active" : ""}`}
            onClick={() => pick(g)}
          >
            {g}
          </button>
        ))}
        <button
          type="button"
          className={`glyph-btn glyph-btn--word${activeGlyph === "GRINDLY" ? " is-active" : ""}`}
          onClick={() => pick("GRINDLY")}
        >
          GRINDLY
        </button>
        <button
          type="button"
          className="glyph-btn glyph-btn--wide"
          aria-pressed={auto}
          onClick={toggleAuto}
        >
          <span className="auto-tick" aria-hidden /> auto-cast
        </button>
      </div>
    </div>
  );
}
