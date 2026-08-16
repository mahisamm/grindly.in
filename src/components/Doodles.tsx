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
export function Maintenance({ className, size = 96 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      {/* cog teeth */}
      <path
        d="M40 8 h14 l2 9 8 4 8-5 10 10 -5 8 4 8 9 2 v14 l-9 2 -4 8 5 8 -10 10 -8-5 -8 4 -2 9 H40 l-2-9 -8-4 -8 5 -10-10 5-8 -4-8 -9-2 V46 l9-2 4-8 -5-8 10-10 8 5 8-4 z"
        {...base}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <circle cx="47" cy="53" r="17" fill="var(--vermilion)" fillOpacity="0.16" stroke="none" />
      <circle cx="47" cy="53" r="17" {...base} />
      {/* wrench laid across the cog */}
      <path
        d="M62 34 a11 11 0 0 0 -14 14 L28 68 a6 6 0 0 0 8 8 L56 56 a11 11 0 0 0 14-14 l-8 8 -6-6 z"
        fill="var(--paper)"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PaperPlane({ className, size = 86 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <path d="M8 50 L92 14 L66 90 L50 60 Z" {...base} />
      <path d="M50 60 L92 14" {...base} />
      <path d="M8 50 L50 60" {...base} />
      <path d="M12 76 q 10 -2 16 -10" {...base} strokeWidth={1.8} strokeDasharray="1 7" />
    </svg>
  );
}

export function Resume({ className, size = 84 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <path d="M24 10 H64 L80 26 V90 H24 Z" {...base} fill="#fff" />
      <path d="M64 10 V26 H80" {...base} />
      <path d="M34 40 H70 M34 52 H70 M34 64 H58" {...base} strokeWidth={2} />
      <circle cx="68" cy="74" r="13" fill="var(--vermilion)" stroke="var(--ink)" strokeWidth={2.4} />
      <path d="M62 74 l4 4 l8 -9" {...base} stroke="#fff" />
    </svg>
  );
}

export function Sparkle({ className, size = 40 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <path d="M20 3 C 22 14 26 18 37 20 C 26 22 22 26 20 37 C 18 26 14 22 3 20 C 14 18 18 14 20 3 Z"
        fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Arrow({ className, size = 70 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 60" aria-hidden>
      <path d="M6 40 q 30 -34 70 -20" {...base} />
      <path d="M62 8 l16 12 l-20 8" {...base} />
    </svg>
  );
}

export function Clock({ className, size = 64 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <circle cx="40" cy="42" r="28" {...base} />
      <path d="M40 42 V26 M40 42 L54 50" {...base} />
      <path d="M22 12 L32 20 M58 12 L48 20" {...base} strokeWidth={2} />
    </svg>
  );
}

export function Bolt({ className, size = 40 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <path d="M23 3 L9 23 H19 L17 37 L31 17 H21 Z" fill="currentColor" stroke="none" strokeLinejoin="round" />
    </svg>
  );
}

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

export function Slack({ className, size = 76 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <rect x="18" y="30" width="44" height="26" rx="13" {...base} />
      <path d="M30 30 V22 a8 8 0 0 1 16 0 V30" {...base} />
      <path d="M30 43 H50" {...base} strokeWidth={2} />
      <circle cx="40" cy="68" r="3" fill="currentColor" stroke="none" />
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

export function Star({ className, size = 28 }: D) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <path d="M14 2 l3.4 7.6 L25.5 11 l-6 5.6 1.6 8.2 L14 20.8 L6.9 24.8 8.5 16.6 2.5 11 l8.1 -1.4 Z"
        fill="currentColor" stroke="none" />
    </svg>
  );
}
