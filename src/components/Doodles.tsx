/* Hand-drawn line-art doodles — rough single-stroke, sketchbook feel.
   Inherit ink color via currentColor; accent fills passed where wanted. */

type D = { className?: string; size?: number };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function Magnifier({ className, size = 96 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <circle cx="42" cy="42" r="26" {...base} />
      <circle cx="42" cy="42" r="26" fill="var(--vermilion)" fillOpacity="0.16" stroke="none" />
      <path d="M61 61 L84 84" {...base} strokeWidth={4} />
      <path d="M30 40 q 4 -12 18 -10" {...base} strokeWidth={2} />
    </svg>
  );
}

/** Gear + wrench — shown when sign-ups are paused for maintenance. */
export function Target({ className, size = 80 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <circle cx="40" cy="40" r="30" {...base} />
      <circle cx="40" cy="40" r="19" {...base} />
      <circle cx="40" cy="40" r="7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Doc({ className, size = 76 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <path d="M20 8 H50 L64 22 V72 H20 Z" {...base} />
      <path d="M50 8 V22 H64" {...base} />
      <path d="M28 36 H56 M28 46 H56 M28 56 H46" {...base} strokeWidth={2} />
    </svg>
  );
}

export function Shield({ className, size = 76 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <path d="M40 8 L66 18 V38 C66 57 54 68 40 74 C26 68 14 57 14 38 V18 Z" {...base} />
      <path d="M29 40 l7 8 l15 -18" {...base} />
    </svg>
  );
}

