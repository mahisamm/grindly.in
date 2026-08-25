/**
 * What you get, and what it costs.
 *
 * Two decisions are encoded here and both are deliberate.
 *
 * NO SUBSCRIPTION. A placement season is six to ten weeks. Charging monthly for
 * a product someone needs once means most of the revenue comes from people who
 * forgot to cancel, which is a business that generates refunds and bad reviews
 * from customers who were otherwise happy. A pass expires on its own and the
 * user keeps everything they made.
 *
 * PRICED IN RUPEES. The comparable tools charge $29-50/month, which is
 * ₹2,500-4,100 — not a real price for an Indian student. The tools that
 * actually sell here run ₹10-249. A converted dollar price would have been the
 * lazy choice and would have priced out the entire target market.
 *
 * The free tier is deliberately useful rather than crippled: the full
 * machine-readability report and score forever, plus a LIFETIME taste of the
 * expensive operations (see LIMITS.free). A free tier that shows a blurred
 * score teaches people you are a paywall, and they leave before seeing that
 * the product works — but a free tier that refills daily teaches patient
 * people to never pay, which is the other cliff this shape steers between.
 */

export type PlanId = "free" | "pack" | "pass" | "admin";

/**
 * What a payment can actually grant as a TIER.
 *
 * `Product.grants` used to be `Exclude<PlanId, "free">`, which includes "admin"
 * — a tier that is granted by a role on the user row and is deliberately not
 * reachable by paying. Nothing ever set it, but the type said a product could,
 * and the compiler had to be told otherwise the moment `User.plan` became an
 * enum that does not contain it. "pack" left this type when the ₹99 product
 * became a per-target unlock — no purchase grants that tier any more, it only
 * survives on accounts that bought it before the change.
 */
export type PurchasablePlan = Extract<PlanId, "pass">;

/**
 * The stand-in for "no cap".
 *
 * A real number rather than `Infinity`, because these values are counted
 * against, arithmetic'd, and serialised to the browser — and `JSON.stringify`
 * turns `Infinity` into `null`, which would reach the dashboard as "1 of null
 * used on your plan". A million rewrites a day is not reachable by a person,
 * so the cap still exists and still bounds a runaway loop; it just never fires
 * for someone using the product.
 *
 * Anything at or above this is DISPLAYED as "unlimited" — see `formatLimit`.
 * Never print the number.
 */
export const UNLIMITED = 1_000_000;

/** A limit as a person should read it. */
export function formatLimit(n: number): string {
  return n >= UNLIMITED ? "unlimited" : String(n);
}

/** True when this limit is effectively no limit, so the UI can drop the counter. */
export function isUnlimited(n: number): boolean {
  return n >= UNLIMITED;
}

export type Limits = {
  /** Resumes stored at once. */
  resumes: number;
  /** Variant batches — the expensive operation (models + Chromium). PER DAY
      for paid tiers; for `free` this is a LIFETIME total (see quota.ts): a
      daily reset just taught patient users to wait for midnight. */
  variantRunsPerDay: number;
  /** Model-written advice calls. Per day for paid tiers, lifetime for free —
      same reasoning as variant runs. */
  adviceRunsPerDay: number;
  /** Uploads per day, to bound the parse work a single account can cause.
      Daily for every tier — an upload costs parsing, not model calls. */
  uploadsPerDay: number;
  /** Distinct company/JD targets a resume may have. For `free` this is a
      sanity cap on ROWS, not on value: creating a target and reading its gap
      report is free for everyone; RUNNING against one needs that target
      unlocked (₹99) or a pass. */
  targetsPerResume: number;
};

export const LIMITS: Record<PlanId, Limits> = {
  // The free taste: the full report forever, two general rebuilds EVER plus
  // one company-specific taste tracked separately on the user row. One strong
  // answer per run makes a third general batch unnecessary and keeps the free
  // tier useful without teaching people to postpone paying indefinitely.
  // shape (2/day) reset at midnight, so anyone patient drank free
  // indefinitely — the operator's explicit objection. Lifetime totals leave
  // nothing to wait for.
  free: {
    resumes: 2,
    variantRunsPerDay: 2,
    adviceRunsPerDay: 3,
    uploadsPerDay: 5,
    targetsPerResume: 20,
  },
  // LEGACY: the old ₹99 product granted this 7-day tier. It is no longer
  // sold — pack1 now unlocks a single target instead (see PRODUCTS) — but
  // accounts still inside a previously-bought window keep these limits until
  // it expires and effectivePlan sends them back to free.
  pack: {
    resumes: 2,
    variantRunsPerDay: 4,
    adviceRunsPerDay: 6,
    uploadsPerDay: 6,
    targetsPerResume: 2,
  },
  pass: {
    resumes: 25,
    variantRunsPerDay: 40,
    adviceRunsPerDay: 60,
    uploadsPerDay: 40,
    targetsPerResume: 40,
  },
  // Not a tier anyone can buy. It is granted by `role = 'admin'` on the user
  // row, which only `scripts/seed-admin.mjs` sets and only from the ADMIN_EMAIL
  // environment variable — so it cannot be reached by signing up, by paying, or
  // by anything a request can do.
  //
  // It exists because the person running this has to be able to exercise the
  // product to see whether it works, and hitting "you have used all 2 rewrites
  // for today" while testing a rewrite is a bad way to find out. Quotas here
  // are about bounding cost from strangers, and the operator is not a stranger.
  admin: {
    resumes: UNLIMITED,
    variantRunsPerDay: UNLIMITED,
    adviceRunsPerDay: UNLIMITED,
    uploadsPerDay: UNLIMITED,
    targetsPerResume: UNLIMITED,
  },
};

export type Sku = "pass90" | "pack1";

/**
 * What a purchase IS, structurally. Two shapes on purpose:
 *
 *   kind "plan"   — buys the user a tier for `days` (the Season Pass).
 *   kind "target" — buys ONE company target a permanent unlock on one resume.
 *     No tier, no expiry, no user.plan change; the grant is a timestamp on the
 *     target row. This replaced the 7-day "pack" tier, which sold time when
 *     what people were buying was a company.
 *
 * A discriminated union rather than optional fields, so the grant paths in
 * pay/confirm and pay/webhook cannot read `days` off a product that has none.
 */
export type Product =
  | {
      sku: Sku;
      kind: "plan";
      name: string;
      /** Smallest currency unit — paise. Razorpay wants paise; so does arithmetic. */
      amount: number;
      currency: "INR";
      /** Which tier this grants. Written on the product, not assumed at confirm time. */
      grants: PurchasablePlan;
      days: number;
      blurb: string;
    }
  | {
      sku: Sku;
      kind: "target";
      name: string;
      amount: number;
      currency: "INR";
      blurb: string;
    };

/**
 * Tailored runs allowed against one unlocked target. Each run returns one
 * strongest document. Five deliberate attempts are generous for a person and
 * still put a wall in front of a script. A pass ignores it.
 */
export const TARGET_REGEN_LIMIT = 5;

// `satisfies` rather than an annotation, so each entry keeps its NARROW type:
// `PRODUCTS.pass90.days` compiles because pass90 is known to be kind "plan",
// and `PRODUCTS.pack1.days` is a compile error because an unlock has none.
export const PRODUCTS = {
  pass90: {
    sku: "pass90",
    kind: "plan",
    name: "Season Pass",
    amount: 39900, // ₹399
    currency: "INR",
    grants: "pass",
    days: 90,
    blurb: "Every company, everything unlimited, for one job search. One payment, no auto-renew.",
  },
  pack1: {
    sku: "pack1",
    kind: "target",
    name: "Company unlock",
    amount: 9900, // ₹99
    currency: "INR",
    blurb: "One company, unlocked for good: tailored rebuilds, the gap report, a cover letter.",
  },
} satisfies Record<Sku, Product>;

export function isSku(value: string): value is Sku {
  return value === "pass90" || value === "pack1";
}

/**
 * The dollar sheet, in cents — what non-Indian visitors SEE today and will
 * pay when the merchant-of-record rail exists. Deliberately not a currency
 * conversion of the rupee prices: abroad these compete with $29-a-MONTH
 * subscriptions, and a converted ₹99 (~$1.15) both signals "toy" and loses
 * half of itself to fixed processor fees. Nothing sells in USD yet — the
 * pricing page's foreign buttons say "coming soon" and every purchase path
 * still runs INR through Razorpay only.
 */
export const USD_PRICES: Record<Sku, number> = {
  pass90: 2900, // $29
  pack1: 799, // $7.99
};

/** ₹399 from 39900. Uses the Indian grouping the audience reads. */
export function formatAmount(paise: number, currency = "INR"): string {
  const major = paise / 100;
  if (currency !== "INR") return `${currency} ${major.toFixed(2)}`;
  return `₹${major.toLocaleString("en-IN", {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The plan a user is actually on right now.
 *
 * Expiry is evaluated here, on read, rather than by a nightly job that flips the
 * column. A cron that has not run yet — or that failed last night — would
 * otherwise leave expired passes active, and "the billing state is whatever the
 * last successful cron said" is a bug that only shows up in production.
 */
export function effectivePlan(user: {
  plan?: string | null;
  planExpiresAt?: Date | null;
  role?: string | null;
}): PlanId {
  // Role first, and it does not expire. An admin whose pass ran out is still
  // the operator; billing state has nothing to say about that.
  if (user.role === "admin") return "admin";
  const plan = user.plan;
  if (plan !== "pass" && plan !== "pack") return "free";
  if (!user.planExpiresAt) return "free";
  return user.planExpiresAt.getTime() > Date.now() ? plan : "free";
}

export function limitsFor(user: {
  plan?: string | null;
  planExpiresAt?: Date | null;
  role?: string | null;
}): Limits {
  return LIMITS[effectivePlan(user)];
}

/** Whole days left on a pass, or null when there is no active pass. */
export function daysRemaining(user: {
  plan?: string | null;
  planExpiresAt?: Date | null;
  role?: string | null;
}): number | null {
  const plan = effectivePlan(user);
  // An admin's access has no end date, so there is no countdown to show.
  if (plan === "free" || plan === "admin" || !user.planExpiresAt) return null;
  const ms = user.planExpiresAt.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Extend rather than replace. Buying a second pass while one is live adds to
 * the end of it — anything else silently takes time the user already paid for.
 */
export function extendedExpiry(current: Date | null | undefined, days: number): Date {
  const now = Date.now();
  const base = current && current.getTime() > now ? current.getTime() : now;
  return new Date(base + days * 86_400_000);
}
