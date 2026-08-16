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
 * machine-readability report, one resume, one company pack. A free tier that
 * shows a blurred score teaches people you are a paywall, and they leave before
 * seeing that the product works.
 */

export type PlanId = "free" | "pack" | "pass";

export type Limits = {
  /** Resumes stored at once. */
  resumes: number;
  /** Variant batches per day — the expensive operation (models + Chromium). */
  variantRunsPerDay: number;
  /** Model-written advice calls per day. */
  adviceRunsPerDay: number;
  /** Uploads per day, to bound the parse work a single account can cause. */
  uploadsPerDay: number;
  /** Distinct company/JD targets a resume may have. */
  targetsPerResume: number;
};

export const LIMITS: Record<PlanId, Limits> = {
  free: {
    resumes: 2,
    variantRunsPerDay: 2,
    adviceRunsPerDay: 3,
    uploadsPerDay: 5,
    targetsPerResume: 1,
  },
  // The ₹99 single-company pack. It used to grant `pass` outright, so ₹99 bought
  // the entire ₹399 tier for a week — 25 resumes, 40 rewrites a day, every
  // company pack — while the pricing card said "one company, three rebuilds".
  // Its own tier now matches what is being sold.
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
};

export type Sku = "pass90" | "pack1";

export type Product = {
  sku: Sku;
  name: string;
  /** Smallest currency unit — paise. Razorpay wants paise; so does arithmetic. */
  amount: number;
  currency: "INR";
  /** Which tier this grants. Written on the product, not assumed at confirm time. */
  grants: Exclude<PlanId, "free">;
  days: number;
  blurb: string;
};

export const PRODUCTS: Record<Sku, Product> = {
  pass90: {
    sku: "pass90",
    name: "Season Pass",
    amount: 39900, // ₹399
    currency: "INR",
    grants: "pass",
    days: 90,
    blurb: "Everything, for one job search. One payment, no auto-renew.",
  },
  pack1: {
    sku: "pack1",
    name: "Single company pack",
    amount: 9900, // ₹99
    currency: "INR",
    grants: "pack",
    days: 7,
    blurb: "Three tailored variants for one company, plus the gap report.",
  },
};

export function isSku(value: string): value is Sku {
  return value === "pass90" || value === "pack1";
}

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
}): PlanId {
  const plan = user.plan;
  if (plan !== "pass" && plan !== "pack") return "free";
  if (!user.planExpiresAt) return "free";
  return user.planExpiresAt.getTime() > Date.now() ? plan : "free";
}

export function limitsFor(user: { plan?: string | null; planExpiresAt?: Date | null }): Limits {
  return LIMITS[effectivePlan(user)];
}

/** Whole days left on a pass, or null when there is no active pass. */
export function daysRemaining(user: {
  plan?: string | null;
  planExpiresAt?: Date | null;
}): number | null {
  if (effectivePlan(user) === "free" || !user.planExpiresAt) return null;
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
