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
  /**
   * "model" when a provider read the resume; "heuristic" when every provider
   * was unreachable and the agent filled the shape from rules. The shapes are
   * identical, which is exactly why the label exists: the advice route refunds
   * and says "try again" on "heuristic" instead of storing rules as a review.
   */
  source?: "model" | "heuristic";
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

/**
 * A company we were asked about that has no curated pack.
 *
 * `tailoring` is the whole point of the shape. "not_required" is a successful
 * answer, not an error: for most employers there is nothing specific and
 * checkable to say about how they screen, and saying so is better than
 * generating a plausible paragraph about a company nobody has published
 * anything about.
 */
export type CompanyResearch = {
  ok: true;
  tailoring: "curated" | "generated" | "not_required";
  name: string;
  slug?: string;
  summary: string;
  emphasis: string[];
  keywords: string[];
  confidence?: number;
  size?: string;
  /** Why we declined, or what a generated pack is and is not. */
  note?: string;
  sources?: CompanySource[];
  disclaimer: string;
};

/**
 * The score a rebuild has to reach before we hand it over.
 *
 * MUST equal `agent/readiness.SHIPPABLE_FLOOR`. It is duplicated rather than
 * fetched because it is a constant the UI needs to render a static page, and a
 * round trip to Python to learn the number 80 is a worse trade than this
 * comment. `tests/floor.test.ts` reads the Python source and fails if the two
 * ever drift.
 */
export const SHIPPABLE_FLOOR = 80;

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

// ---------------------------------------------------------------------------
// Reading what the database holds
//
// These columns are `jsonb` and Prisma types them as `JsonValue` — which is
// honest, because nothing about the column guarantees the shape. They were
// `String` until the migration that made them jsonb, and every reader did its
// own `JSON.parse` inside its own try/catch, returning `any` on success. Five
// copies of that helper existed across the app, two of them subtly different,
// and all of them agreed to trust whatever came back.
//
// The value is written by a Python subprocess and survives a schema change, a
// pipeline change and a restored backup. Parsing it is the boundary where it
// stops being data of unknown shape and starts being a Report — so that is
// where it gets checked, once, rather than being cast and hoped for.
//
// Every parser below returns null rather than throwing. A resume whose report
// is unreadable must still render its page: the product's answer to "we could
// not read this" is a sentence on screen, never a 500.
// ---------------------------------------------------------------------------

import { z } from "zod";

const severity = z.enum(["critical", "warning"]);

export const FindingSchema = z.object({
  severity,
  band: z.string(),
  problem: z.string(),
  fix: z.string(),
});

export const BandSchema = z.object({
  score: z.number(),
  weight: z.number(),
  points: z.number(),
});

export const AdviceSchema = z.object({
  strengths: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  source: z.enum(["model", "heuristic"]).optional(),
});

export const ReportSchema = z.object({
  score: z.number(),
  grade: z.string(),
  bands: z.record(z.string(), BandSchema).default({}),
  findings: z.array(FindingSchema).default([]),
  // `facts` is a bag of whatever each band chose to record about the document.
  // Deliberately unconstrained: it is diagnostic detail that the pipeline adds
  // to freely, and a schema that had to be widened every time a band learned to
  // measure something new would be a schema people route around.
  facts: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  targeted: z.boolean().default(false),
  advice: AdviceSchema.nullish(),
});

export const FidelitySchema = z.object({
  total: z.number(),
  recovered: z.number(),
  lost: z.array(z.string()).default([]),
  pct: z.number(),
});

export const JobSpecSchema = z.object({
  title: z.string().default(""),
  company: z.string().default(""),
  must_have: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  source_chars: z.number().default(0),
  llm_added: z.array(z.string()).default([]),
});

/** What a Target stores about what it was aimed at. */
export const TargetSpecSchema = z.object({
  skills: z.array(z.string()).default([]),
  must_have: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  emphasis: z.array(z.string()).default([]),
  tailoring: z.string().optional(),
  /** "user" when the text came from the candidate rather than an employer. */
  source: z.string().optional(),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

/** Contact details read off the resume header, locally, never from a model. */
export const ContactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  contact_line: z.string().optional(),
}).loose();
export type Contact = z.infer<typeof ContactSchema>;

const StringArraySchema = z.array(z.string());

/**
 * Parse one jsonb column, or null.
 *
 * Logs a mismatch rather than swallowing it: a report that stopped parsing
 * means the Python side changed shape without the TypeScript side hearing about
 * it, and the visible symptom — a resume page with no score on it — gives no
 * hint of that. The user still gets a page; the operator gets a line.
 */
function parseColumn<T>(schema: z.ZodType<T>, value: unknown, what: string): T | null {
  if (value === null || value === undefined) return null;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  console.error(`[reportTypes] ${what} did not match its schema:`, result.error.issues.slice(0, 3));
  return null;
}

export const readReport = (v: unknown): Report | null => parseColumn(ReportSchema, v, "report");
export const readAdvice = (v: unknown): Advice | null => parseColumn(AdviceSchema, v, "advice");
export const readFidelity = (v: unknown): Fidelity | null => parseColumn(FidelitySchema, v, "fidelity");
export const readTargetSpec = (v: unknown): TargetSpec | null => parseColumn(TargetSpecSchema, v, "target spec");
export const readContact = (v: unknown): Contact => parseColumn(ContactSchema, v, "contact") ?? {};

/**
 * A list of strings, always. Used for skills, links and the plain-English
 * changes on a variant — three columns whose readers all wanted "an array, or
 * an empty one" and each wrote their own version of that.
 */
export const readStrings = (v: unknown): string[] =>
  parseColumn(StringArraySchema, v, "string list") ?? [];

/**
 * A report safe to show someone who is not its owner.
 *
 * The share link promises to expose the measurement and not the person. It did
 * not. `report.facts` carries each band's diagnostic detail, and the `fields`
 * band records exactly what a parser recovered — which is the candidate's email
 * address, phone number and profile links. The whole report object was
 * serialised into the shared page, so anyone with the URL had them.
 *
 * Caught by fetching a real share link off production and grepping the HTML for
 * the test account's contact details. Both were there.
 *
 * Two things happen here:
 *
 *   * `facts` is dropped entirely. Nothing renders it — ReportPanel reads score,
 *     bands and findings and never touches it — so on the shared page it was
 *     pure payload, and payload containing an email address.
 *   * Findings are scrubbed anyway. They are generated sentences rather than
 *     quoted document text, but they are written by a scorer that is free to
 *     change, and a share link is the wrong place to find out that one of them
 *     started quoting the header.
 */
export function toPublicReport(report: Report): Report {
  return {
    ...report,
    facts: {},
    findings: report.findings.map((f) => ({
      ...f,
      problem: scrubContact(f.problem),
      fix: scrubContact(f.fix),
    })),
  };
}

/**
 * Remove anything that looks like a way to contact a person.
 *
 * Deliberately blunt and deliberately over-eager: this runs on text that is
 * about to be shown to a stranger, so a mangled sentence is a far better
 * outcome than a leaked phone number. The patterns mirror agent/redact.py,
 * which does the same job at the model boundary.
 */
export function scrubContact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}
