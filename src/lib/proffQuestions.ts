/**
 * "Proff questions" — the profile/preference questions the agent needs before
 * it builds a plan and starts applying. These map directly onto Profile fields
 * and become the agent's hard limits (what it may / may not apply to).
 */

export type FieldType = "tags" | "select" | "number" | "toggle" | "text";

export type ProffField = {
  key: string;
  label: string;
  help: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
  suffix?: string;
  group: "About you" | "Targeting" | "Limits & rules";
};

export const CONTACT_FIELDS = [
  { key: "phone", label: "Phone number", help: "Used to fill phone fields in application forms.", type: "text" as const, placeholder: "e.g. 9876543210" },
  { key: "gpa", label: "GPA / CGPA", help: "Used to fill GPA fields in application forms (0–10).", type: "number" as const, suffix: "/10" },
] as const;

export const PROFF_FIELDS: ProffField[] = [
  // "About you" collects the FACTS screening forms ask on nearly every
  // application. They live here rather than in a model's imagination because
  // the agent states them under the user's name — agent/questions.py refuses to
  // invent exactly this class of answer, so an application whose form asks for
  // one we do not hold waits for the user instead of being sent with a guess.
  // lib/readiness.ts gates auto-apply on them.
  {
    key: "education",
    label: "Course and college",
    help: "Written onto application forms exactly as you type it.",
    type: "text",
    placeholder: "e.g. B.Tech CSE, VIT Vellore",
    group: "About you",
  },
  {
    key: "gradYear",
    label: "Expected graduation year",
    help: "Nearly every internship form asks. Also decides which roles you are eligible for.",
    type: "number",
    suffix: "year",
    group: "About you",
  },
  {
    key: "availability",
    label: "When can you start?",
    help: "Stated verbatim on forms that ask about availability.",
    type: "text",
    placeholder: "e.g. Immediately, or June 2027",
    group: "About you",
  },
  {
    key: "workAuthorization",
    label: "Work authorization",
    help: "How you are eligible to work where you are applying. Copied as written, never guessed.",
    type: "text",
    placeholder: "e.g. Indian citizen",
    group: "About you",
  },
  {
    key: "preferredDomains",
    label: "Which domains do you want internships in?",
    help: "The agent only applies inside these. Leave empty to let it infer from your resume.",
    type: "tags",
    placeholder: "e.g. Web Development, Data Science, UI/UX",
    group: "Targeting",
  },
  {
    key: "preferredLocations",
    label: "Preferred locations",
    help: "Cities you'd accept. Add 'Remote' for work-from-home roles.",
    type: "tags",
    placeholder: "e.g. Remote, Bangalore, Hyderabad",
    group: "Targeting",
  },
  {
    key: "workMode",
    label: "Work mode",
    help: "Filters listings before the agent even scores them.",
    type: "select",
    options: ["any", "remote", "onsite"],
    group: "Targeting",
  },
  {
    key: "experienceLevel",
    label: "Where are you in your journey?",
    help: "Tunes which roles count as a match.",
    type: "select",
    options: ["student", "fresher", "1-2yr"],
    group: "Targeting",
  },
  {
    key: "stipendMin",
    label: "Minimum monthly stipend",
    help: "Skip anything below this. 0 = unpaid is fine.",
    type: "number",
    suffix: "₹/mo",
    group: "Limits & rules",
  },
  {
    key: "minMatchScore",
    label: "Minimum match score",
    help: "The agent only surfaces a role when resume↔role fit is at least this (0–100). Higher = pickier: fewer but better-fit applications. Quality of match matters more than volume.",
    type: "number",
    suffix: "/100",
    group: "Limits & rules",
  },
  {
    key: "excludedCompanies",
    label: "Companies to avoid",
    help: "The agent will never apply to these.",
    type: "tags",
    placeholder: "e.g. Acme Corp",
    group: "Limits & rules",
  },
  {
    key: "autoApply",
    // This toggle now genuinely governs sending, not just preparing — the worker
    // reads it before any unattended submit (agent/worker.py), so the label had
    // to stop describing it as a prep-only switch.
    label: "Let the agent apply for me",
    help: "On = the agent fills in and sends every application it can deliver on its own — a company's own form, an HR inbox, a careers portal like Greenhouse or Lever, and Internshala if you've connected it. Nothing needed from you. Applications that only exist on LinkedIn/Naukri/Indeed/Unstop still wait for your tap, because those sit behind an account you can't afford to lose. Off = the agent only finds and prepares; nothing is ever sent without you.",
    type: "toggle",
    group: "Limits & rules",
  },
];

export const DEFAULTS: Record<string, unknown> = {
  // Eligibility facts start EMPTY on purpose. A plausible default here would be
  // a fact invented on the user's behalf and then stated to an employer, which
  // is the one thing this system must never do; readiness holds auto-apply
  // until the user fills them in themselves.
  education: "",
  gradYear: 0,
  availability: "",
  workAuthorization: "",
  preferredDomains: [],
  preferredLocations: ["Remote"],
  workMode: "any",
  experienceLevel: "student",
  stipendMin: 0,
  minMatchScore: 65,
  excludedCompanies: [],
  autoApply: true,
  // Same "start empty" rule as the eligibility facts above — the agent
  // prefills these off the resume (agent/resume_ai.py extract_contact); a
  // guessed default here is exactly the kind of invented fact it exists to
  // avoid stating on a real form.
  phone: "",
  gpa: 0,
};
