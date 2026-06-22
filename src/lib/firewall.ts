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

function parseStipend(s?: string | null): number | null {
  if (!s) return null;
  const nums = String(s).match(/\d[\d,]*/g);
  if (!nums) return null;
  const vals = nums.map((n) => parseInt(n.replace(/,/g, ""), 10)).filter((n) => !isNaN(n));
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
