// Hard-gate firewall — the LAST check before any application is submitted.
// Pure + unit-tested. Mirrors agent/matcher.py:firewall_block so the TS app
// and the Python worker enforce identical hard limits.
//
// Rule: if canApply(...).ok is false, the agent MUST NOT apply, regardless of
// match score or auto-apply setting. Excluded company / wrong work-mode /
// below stipend / below min score are non-negotiable.

import { FAILURE_REASON } from "./applyState";

export type FirewallJob = {
  company?: string | null;
  location?: string | null;
  stipend?: string | null;
  matchScore?: number | null;
};

export type FirewallProfile = {
  excludedCompanies?: string | null; // JSON array string
  workMode?: string | null; // remote | onsite | any
  stipendMin?: number | null;
  minMatchScore?: number | null;
};

export type FirewallResult = { ok: true } | { ok: false; reason: string; code: string };

function jsonList(v?: string | null): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function fuzzyCompanyMatch(company: string, excluded: string): boolean {
  const c = company.toLowerCase().trim();
  const e = excluded.toLowerCase().trim();
  if (!e) return false;
  if (c.includes(e) || e.includes(c)) return true;
  const cw = c.split(/\s+/);
  const ew = e.split(/\s+/);
  return !!cw[0] && !!ew[0] && cw[0] === ew[0];
}

function unitMult(u?: string): number {
  if (u === "k") return 1_000;
  if (u === "l" || u === "lpa" || u === "lakh" || u === "lac") return 100_000;
  return 1;
}

// Parse a free-text stipend into a rupee number.
//  - "unpaid"/"none" → 0 (explicit zero, so a >0 floor blocks it).
//  - units: "10k" → 10000, "6 LPA"/"6 lakh" → 600000.
//  - ranges: "10-15k" → 10000 (the trailing unit governs BOTH ends, so the low
//    bound isn't misread as ₹10 and used to wrongly block a real stipend).
//  - returns null only when genuinely no figure is present (unknown → not gated).
// Mirrors agent/matcher.py:_parse_stipend so TS and Python gate identically.
function parseStipend(s?: string | null): number | null {
  if (!s) return null;
  const str = String(s).toLowerCase();
  if (/\b(unpaid|none|no stipend|nil)\b/.test(str)) return 0;
  const vals: number[] = [];
  const consumed: Array<[number, number]> = [];

  // 1) ranges first — "10-15k", "10 to 15 lpa": apply the unit after B to A too.
  const rangeRe = /(\d[\d,]*\.?\d*)\s*(?:-|–|—|to)\s*(\d[\d,]*\.?\d*)\s*(k|l|lpa|lakh|lac)?/g;
  for (const m of str.matchAll(rangeRe)) {
    const mult = unitMult(m[3]);
    for (const num of [m[1], m[2]]) {
      const v = parseFloat(num.replace(/,/g, ""));
      if (!isNaN(v)) vals.push(Math.round(v * mult));
    }
    const start = m.index ?? 0;
    consumed.push([start, start + m[0].length]);
  }

  // 2) standalone numbers not already captured inside a range span.
  for (const m of str.matchAll(/(\d[\d,]*\.?\d*)\s*(k|l|lpa|lakh|lac)?/g)) {
    const start = m.index ?? 0;
    if (consumed.some(([cs, ce]) => cs <= start && start < ce)) continue;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(v)) continue;
    vals.push(Math.round(v * unitMult(m[2])));
  }
  return vals.length ? Math.min(...vals) : null;
}

export function canApply(job: FirewallJob, profile: FirewallProfile): FirewallResult {
  const company = job.company ?? "";
  const excluded = jsonList(profile.excludedCompanies);
  if (excluded.some((e) => fuzzyCompanyMatch(company, e))) {
    return { ok: false, code: FAILURE_REASON.FIREWALL_BLOCKED, reason: `excluded company ${company}` };
  }

  const workMode = profile.workMode || "any";
  const loc = (job.location || "").toLowerCase();
  const isRemote = loc.includes("remote") || loc.includes("work from home");
  if (workMode === "remote" && !isRemote) {
    return { ok: false, code: FAILURE_REASON.FIREWALL_BLOCKED, reason: "not remote" };
  }
  if (workMode === "onsite" && isRemote) {
    return { ok: false, code: FAILURE_REASON.FIREWALL_BLOCKED, reason: "remote, wanted onsite" };
  }

  const stipendMin = profile.stipendMin ?? 0;
  if (stipendMin > 0) {
    const amt = parseStipend(job.stipend);
    if (amt !== null && amt < stipendMin) {
      return { ok: false, code: FAILURE_REASON.FIREWALL_BLOCKED, reason: `stipend ₹${amt} < min ₹${stipendMin}` };
    }
  }

  const minScore = profile.minMatchScore ?? 0;
  if (job.matchScore != null && job.matchScore < minScore) {
    return { ok: false, code: FAILURE_REASON.FIREWALL_BLOCKED, reason: `score ${job.matchScore} < min ${minScore}` };
  }

  return { ok: true };
}
