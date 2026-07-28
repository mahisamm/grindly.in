// The Apply Kit: everything the extension is allowed to type into a form.
//
// This lives in one place because it was written twice and the two copies did
// not agree. /api/extension/kit returned { profile: {name,…}, answers,
// coverLetter } — the shape fillEngine actually reads — while the autopilot
// claim endpoint returned a flat { fullName, email, … }. fillEngine looked for
// kit.profile, found undefined, and filled NOTHING on every autopilot run. The
// bug was invisible on Internshala, whose Quick Apply has no fields to fill,
// and would have been silent everywhere else too: a form left blank reads as
// "the site asked something we couldn't answer".
//
// One builder, one shape, both callers.

export type KitProfile = {
  name: string;
  email: string;
  phone: string;
  gpa: number | null;
};

export type ApplyKit = {
  profile: KitProfile;
  answers: { q: string; a: string }[];
  coverLetter: string | null;
};

type Userish = {
  name: string | null;
  email: string;
  profile?: {
    phone?: string | null;
    gpa?: number | null;
    education?: string | null;
    degree?: string | null;
    college?: string | null;
    gradYear?: number | null;
    availability?: string | null;
    workAuthorization?: string | null;
    needsSponsorship?: string | null;
    hoursPerWeek?: number | null;
    willingToRelocate?: string | null;
    expectedStipend?: number | null;
    class10Percent?: number | null;
    class12Percent?: number | null;
    linkedinUrl?: string | null;
    githubUrl?: string | null;
    portfolioUrl?: string | null;
  } | null;
};

type AppRow = { coverLetterText?: string | null; answersJson?: string | null } | null;

/** Drafted answers for THIS application. Malformed JSON costs the drafted
 *  answers, never the deterministic profile fills. */
export function parseAnswers(answersJson: string | null | undefined) {
  try {
    const parsed = JSON.parse(answersJson || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && x.q && x.a).map((x) => ({ q: String(x.q), a: String(x.a) }));
  } catch {
    return [];
  }
}

// Facts the user typed during setup, phrased as the questions a form asks. Only
// things they actually supplied appear here — an absent field yields no entry,
// so the engine stops and asks rather than inventing an answer. The matcher is
// containment-based, so "Year of graduation" also answers "What is your year of
// graduation?".
const SETUP_QUESTIONS: [string, (p: NonNullable<Userish["profile"]>) => string | null][] = [
  ["Year of graduation", (p) => (p.gradYear ? String(p.gradYear) : null)],
  ["Education", (p) => p.education || null],
  // Separate entries, because a form asks for them in separate boxes and the
  // matcher is containment-based — "College name" never matched a combined
  // "B.Tech CSE, VIT Vellore" usefully.
  ["College", (p) => p.college || null],
  ["Degree", (p) => p.degree || null],
  ["Availability", (p) => p.availability || null],
  ["Work authorization", (p) => p.workAuthorization || null],
  // The rest of what setup now collects. Without these the extension stops on
  // questions the user has already answered — the whole point of asking once.
  ["Do you require sponsorship", (p) => p.needsSponsorship || null],
  ["Hours per week", (p) => (p.hoursPerWeek ? String(p.hoursPerWeek) : null)],
  ["Willing to relocate", (p) => p.willingToRelocate || null],
  ["Expected stipend", (p) => (p.expectedStipend ? String(p.expectedStipend) : null)],
  ["Class 12 percentage", (p) => fmtPercent(p.class12Percent)],
  ["Class 10 percentage", (p) => fmtPercent(p.class10Percent)],
  ["LinkedIn", (p) => p.linkedinUrl || null],
  ["GitHub", (p) => p.githubUrl || null],
  ["Portfolio", (p) => p.portfolioUrl || null],
];

/** 92 rather than 92.0 — a numeric input often rejects the decimal. */
function fmtPercent(value: number | null | undefined): string | null {
  if (!value) return null;
  return Number.isInteger(value) ? String(value) : String(value);
}

export function buildKit(user: Userish, app?: AppRow): ApplyKit {
  const p = user.profile ?? {};
  // Answers drafted for this specific job come FIRST: the matcher takes the
  // earliest exact/containment hit, and a reply the user reviewed for this
  // employer should beat a generic setup fact.
  const answers = [
    ...parseAnswers(app?.answersJson),
    ...SETUP_QUESTIONS.map(([q, get]) => ({ q, a: get(p) ?? "" })).filter((x) => x.a !== ""),
  ];

  return {
    profile: {
      name: user.name || "",
      email: user.email || "",
      phone: p.phone || "",
      gpa: p.gpa ?? null,
    },
    answers,
    coverLetter: app?.coverLetterText || null,
  };
}
