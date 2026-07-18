// Plan definitions — the single source of truth for pricing and daily caps.
// Mirrors agent/db.py:PLAN_CAPS / normalize_plan(). Keep the two in sync.

export type Plan = "plus" | "pro";
export type PlanOrFree = Plan | "free";

export const PLANS: Record<
  Plan,
  { name: string; price: number; perDay: number; blurb: string }
> = {
  plus: {
    name: "Plus",
    price: 200,
    perDay: 5,
    blurb: "Up to 5 applications a day, every day",
  },
  pro: {
    name: "Pro",
    price: 500,
    perDay: 15,
    blurb: "Up to 15 applications a day + priority support",
  },
};

export const PLAN_CAPS: Record<PlanOrFree, number> = {
  free: 5, // lifetime trial allowance; paid plan caps reset daily
  plus: 5,
  pro: 15,
};

export const FREE_TRIAL_APPLICATIONS = PLAN_CAPS.free;

// "starter" is the old name for "plus" and is still the value on live user rows.
// Every read normalises through here instead of comparing the raw column, so a
// legacy row keeps working with no data migration and no dead branch to forget.
const ALIASES: Record<string, PlanOrFree> = { starter: "plus" };

export function normalizePlan(plan?: string | null): PlanOrFree {
  const p = (plan ?? "free").trim().toLowerCase();
  const mapped = ALIASES[p] ?? p;
  return mapped === "plus" || mapped === "pro" || mapped === "free" ? mapped : "free";
}

export function planCap(plan?: string | null): number {
  return PLAN_CAPS[normalizePlan(plan)];
}
