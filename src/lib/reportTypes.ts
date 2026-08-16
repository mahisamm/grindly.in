/**
 * Shapes and labels shared between the server and the browser.
 *
 * These live apart from `lib/agent.ts` for a concrete reason: that module spawns
 * a subprocess, so it imports `node:child_process`. A client component that
 * imports a *value* from it — even one as innocent as a label map — drags the
 * whole module into the browser bundle and the build fails with "the chunking
 * context does not support external modules". Type-only imports are erased and
 * would have been fine; `BAND_LABELS` is not a type.
 *
 * So: anything both sides need lives here, and here has no Node imports at all.
 */

export type Severity = "critical" | "warning";

export type Finding = {
  severity: Severity;
  band: string;
  problem: string;
  fix: string;
};

export type Band = { score: number; weight: number; points: number };

export type Advice = {
  strengths: string[];
  issues: string[];
  suggestions: string[];
};

export type Report = {
  score: number;
  grade: string;
  bands: Record<string, Band>;
  findings: Finding[];
  facts: Record<string, Record<string, unknown>>;
  targeted: boolean;
  advice?: Advice | null;
};

export type Fidelity = {
  total: number;
  recovered: number;
  lost: string[];
  pct: number;
};

export type JobSpec = {
  title: string;
  company: string;
  must_have: string[];
  nice_to_have: string[];
  skills: string[];
  source_chars: number;
  llm_added: string[];
};

export type CompanySource = { claim: string; url: string; curated_on: string };

export type CompanyPack = {
  slug: string;
  name: string;
  summary: string;
  emphasis: string[];
  keywords: string[];
  sources: CompanySource[];
  best_for: string[];
};

/** Band keys must match `agent/readiness.BAND_WEIGHTS`. */
export const BAND_LABELS: Record<string, string> = {
  readable: "Machine-readable",
  fields: "Contact & dates",
  structure: "Structure",
  impact: "Evidence of impact",
  coverage: "Role coverage",
};

export const BAND_BLURBS: Record<string, string> = {
  readable:
    "Whether text survives extraction at all — the failure that silently sinks every application.",
  fields: "Whether a parser can fill in name, email, phone, links and dates.",
  structure: "Standard headings, real bullets, one column.",
  impact: "Bullets that lead with an action and state an outcome.",
  coverage: "Skills this role asks for that your resume actually shows.",
};

/** Shared with the score dial and the band bars so one colour rule governs both. */
export function scoreColor(score: number): string {
  if (score >= 70) return "var(--brand)";
  if (score >= 40) return "#a8730f";
  return "#a3271b";
}
