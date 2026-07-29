/**
 * "Proff questions" — the profile/preference questions the agent needs before
 * it builds a plan and starts applying. These map directly onto Profile fields
 * and become the agent's hard limits (what it may / may not apply to).
 */

export type FieldType = "tags" | "select" | "number" | "toggle" | "text" | "choice";

export type ProffField = {
  key: string;
  label: string;
  help: string;
  type: FieldType;
  options?: string[];
  /**
   * "choice" fields: pick from `options`, or choose "Something else" and type
   * your own. Everything the agent states on a form is stored as one string
   * either way.
   *
   * The list matters for more than convenience. These answers are typed into
   * real applications, and a free-text box produced values the agent could not
   * use — "around 20-25 hrs depending on my sem" cannot be put in a numeric
   * "hours per week" input, and "asap" is not one of a dropdown's options. A
   * fixed list makes the stored value one the agent can hand to a form as-is,
   * and spares the user guessing what we expect.
   */
  suggestions?: string[];
  /** A "select" whose options are numbers but whose column is an Int. */
  numeric?: boolean;
  placeholder?: string;
  suffix?: string;
  /**
   * Setup will not continue until this has a value.
   *
   * Reserved for questions a real application form has been MEASURED to stop
   * on. Every "About you" answer left blank stalls some application eventually
   * — agent/questions.py refuses to invent any of them — but requiring all
   * fifteen would trade a wall of boxes at signup for a problem the user has
   * not hit yet. So: the measured ones block, the rest are counted and named on
   * the way past (see `blankOptional`), which is the honest version of both.
   */
  required?: boolean;
  group: "About you" | "Education" | "Targeting" | "Limits & rules";
};

// Graduation years offered in setup: last year (someone who just finished) plus
// the next six. A student picks; nobody types a year into a free box and gets it
// stated on an application as fact.
const CURRENT_YEAR = new Date().getFullYear();
export const GRAD_YEARS = Array.from({ length: 8 }, (_, i) => String(CURRENT_YEAR - 1 + i));

export const CONTACT_FIELDS = [
  // Only ever came from Google OAuth before; an account whose Google profile
  // had no name set was permanently stuck with none and no way to add it.
  { key: "name", label: "Full name", help: "Used to fill name fields in application forms.", type: "text" as const, placeholder: "e.g. Priya Sharma" },
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
  // Split from the old single "Course and college" box because forms ask for
  // them separately — answering "College name" with "B.Tech CSE, VIT Vellore"
  // is wrong in a way a recruiter notices. Both arrive pre-filled from the
  // resume (agent/resume_ai.extract_contact).
  {
    key: "degree",
    label: "Your degree",
    help: "Read off your resume — check it. Typed into 'Qualification' and 'Course' boxes.",
    type: "choice",
    options: [
      "B.Tech", "B.E.", "B.Sc", "B.Com", "B.A.", "BCA", "BBA",
      "M.Tech", "M.Sc", "MCA", "MBA", "Diploma",
    ],
    placeholder: "e.g. B.Tech in Computer Science",
    group: "Education",
  },
  {
    key: "college",
    label: "College or university",
    help: "Read off your resume — check it. Typed into 'College name' boxes.",
    type: "text",
    placeholder: "e.g. VIT Vellore",
    group: "Education",
  },
  {
    key: "gradYear",
    label: "Expected graduation year",
    help: "Nearly every internship form asks. Also decides which roles you are eligible for.",
    type: "select",
    options: GRAD_YEARS,
    numeric: true,
    group: "Education",
  },
  {
    key: "class12Percent",
    label: "Class 12 percentage",
    help: "Asked on most Indian internship forms. Your college CGPA is a different number and is never used for this.",
    type: "number",
    suffix: "%",
    group: "Education",
  },
  {
    key: "class10Percent",
    label: "Class 10 percentage",
    help: "Same — asked often, and never guessed from anything else.",
    type: "number",
    suffix: "%",
    group: "Education",
  },
  {
    key: "availability",
    label: "When can you start?",
    help: "Stated on forms that ask about availability or notice period.",
    type: "choice",
    options: ["Immediately", "Within 2 weeks", "Within 1 month", "After my current semester"],
    placeholder: "e.g. From June 2027",
    group: "About you",
  },
  {
    key: "hoursPerWeek",
    label: "Hours a week you can commit",
    help: "Internshala asks this on nearly every listing, and the box only takes a number.",
    type: "select",
    options: ["10", "15", "20", "25", "30", "40"],
    numeric: true,
    suffix: "hrs/week",
    group: "About you",
  },
  {
    key: "willingToRelocate",
    label: "Would you relocate for a role?",
    help: "Answered on forms exactly as picked here.",
    type: "select",
    options: ["Yes", "No", "Depends on the role"],
    group: "About you",
  },
  {
    key: "workAuthorization",
    label: "Work authorization",
    help: "How you are eligible to work where you are applying. Copied as written, never guessed.",
    type: "choice",
    options: [
      "Indian citizen",
      "Indian citizen — need sponsorship to work abroad",
      "Student visa (F-1 / OPT)",
      "Permanent resident",
      "Work permit holder",
    ],
    placeholder: "e.g. Indian citizen",
    group: "About you",
  },
  {
    key: "needsSponsorship",
    label: "Do you need visa sponsorship?",
    help: "Every applicant tracking system asks this as a plain yes/no, and it can't be inferred from the line above without putting words in your mouth.",
    type: "select",
    options: ["No", "Yes"],
    group: "About you",
  },
  {
    key: "expectedStipend",
    label: "Expected stipend",
    help: "Stated when a form asks what you expect. Different from the minimum below, which only decides what the agent opens.",
    type: "select",
    options: ["0", "5000", "10000", "15000", "20000", "25000", "30000", "40000"],
    numeric: true,
    suffix: "₹/mo",
    group: "About you",
  },
  // Measured, not guessed. A dry run of fourteen real application pages stalled
  // three times: twice on "What's your current salary?" and once on "Do you have
  // previous internship experience?". Every one of these is a fact only the user
  // can state, so the agent refuses to invent one — collecting them here is what
  // turns those three stalls into three sent applications.
  {
    key: "currentSalary",
    label: "Your current salary",
    help: "Asked by most applicant tracking systems, including of students. Pick 0 if you aren't earning — the box usually only takes a number.",
    type: "choice",
    options: ["0", "Not currently employed"],
    placeholder: "e.g. 300000",
    required: true,
    group: "About you",
  },
  {
    key: "previousInternship",
    label: "Have you done an internship before?",
    help: "Answered exactly as picked here. Never read off your resume, because a missed line there would state 'no' on your behalf.",
    type: "select",
    options: ["No", "Yes"],
    required: true,
    group: "About you",
  },
  {
    key: "noticePeriod",
    label: "Notice period",
    help: "Asked as its own box, separately from when you can start.",
    type: "choice",
    options: ["Immediate", "15 days", "1 month", "2 months", "3 months"],
    placeholder: "e.g. Immediate",
    group: "About you",
  },
  {
    key: "currentLocation",
    label: "Where are you based right now?",
    help: "The city you are in today — different from the locations you'd accept a role in.",
    type: "text",
    placeholder: "e.g. Hyderabad",
    group: "About you",
  },
  {
    key: "dateOfBirth",
    label: "Date of birth",
    help: "Required on many Indian application portals. Typed exactly as written here.",
    type: "text",
    placeholder: "e.g. 14/03/2005",
    group: "About you",
  },
  {
    key: "nationality",
    label: "Nationality",
    help: "Its own box on most portals, separate from work authorization above.",
    type: "choice",
    options: ["Indian"],
    placeholder: "e.g. Indian",
    group: "About you",
  },
  {
    key: "gender",
    label: "Gender",
    help: "Optional. Asked on the diversity section of most application forms. Leave blank and those applications wait for you rather than being sent with a guess.",
    type: "choice",
    options: ["Male", "Female", "Non-binary", "Prefer not to say"],
    placeholder: "Type your own",
    group: "About you",
  },
  {
    key: "differentlyAbled",
    label: "Do you identify as differently abled?",
    help: "Optional, and asked as a required box on several Indian portals.",
    type: "select",
    options: ["No", "Yes", "Prefer not to say"],
    group: "About you",
  },
  {
    key: "linkedinUrl",
    label: "LinkedIn profile",
    help: "Forms ask for this in its own box. Read off your resume where possible.",
    type: "text",
    placeholder: "linkedin.com/in/yourname",
    group: "About you",
  },
  {
    key: "githubUrl",
    label: "GitHub profile",
    help: "Same — its own box on most technical applications.",
    type: "text",
    placeholder: "github.com/yourname",
    group: "About you",
  },
  {
    key: "portfolioUrl",
    label: "Portfolio or personal site",
    help: "Optional. Left blank if you don't have one.",
    type: "text",
    placeholder: "yourname.dev",
    group: "About you",
  },
  {
    key: "preferredDomains",
    label: "Which domains do you want internships in?",
    help: "The agent only applies inside these. Leave empty to let it infer from your resume.",
    type: "tags",
    placeholder: "e.g. Web Development, Data Science, UI/UX",
    // Tap-to-add, because the wording here decides which listings are even
    // searched — a typo or an invented category quietly narrows the search to
    // nothing, and the user has no way to see that happening.
    suggestions: [
      "Web Development", "Mobile Development", "Data Science", "Machine Learning",
      "Artificial Intelligence", "Backend Development", "Frontend Development",
      "Full Stack Development", "DevOps", "Cloud Computing", "Cybersecurity",
      "UI/UX Design", "Product Management", "Business Analytics", "Data Analytics",
      "Software Testing", "Embedded Systems", "Digital Marketing", "Content Writing",
      "Graphic Design", "Human Resources", "Finance", "Operations", "Sales",
    ],
    group: "Targeting",
  },
  {
    key: "preferredLocations",
    label: "Preferred locations",
    help: "Cities you'd accept. Add 'Remote' for work-from-home roles.",
    type: "tags",
    placeholder: "e.g. Remote, Bangalore, Hyderabad",
    suggestions: [
      "Remote", "Bangalore", "Hyderabad", "Pune", "Chennai", "Mumbai", "Delhi",
      "Noida", "Gurgaon", "Kolkata", "Ahmedabad", "Jaipur", "Kochi",
      "Coimbatore", "Indore", "Chandigarh", "Bhubaneswar", "Anywhere in India",
    ],
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
  degree: "",
  college: "",
  gradYear: 0,
  class10Percent: 0,
  class12Percent: 0,
  availability: "",
  hoursPerWeek: 0,
  willingToRelocate: "",
  workAuthorization: "",
  needsSponsorship: "",
  expectedStipend: 0,
  currentSalary: "",
  previousInternship: "",
  noticePeriod: "",
  currentLocation: "",
  dateOfBirth: "",
  nationality: "",
  gender: "",
  differentlyAbled: "",
  linkedinUrl: "",
  githubUrl: "",
  portfolioUrl: "",
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
  name: "",
  phone: "",
  gpa: 0,
};

/**
 * Has the user actually answered this question?
 *
 * Deliberately the same rule agent/questions.py applies (`if matches and value`),
 * because the two must agree about what counts as a held fact: a question setup
 * calls answered but the agent calls blank is an application that stalls with
 * nothing on screen explaining why.
 *
 * So a numeric 0 is NOT an answer — it is the empty marker every numeric field
 * in DEFAULTS starts at (gradYear, class12Percent, gpa), and nobody scored 0% in
 * class 12. A STRING "0" is an answer: it can only get there by being picked
 * from a dropdown, which is exactly how a student states a current salary of
 * zero.
 */
function answered(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return String(value ?? "").trim() !== "";
}

/**
 * Required questions still unanswered. Setup blocks on these.
 *
 * Note what counts as answered: 0 and "No" are ANSWERS, not blanks. A student
 * earning nothing has a current salary of zero, and the agent can put that in a
 * form; what it cannot do is put anything in a box the user never filled.
 */
export function missingRequired(form: Record<string, unknown>): ProffField[] {
  return PROFF_FIELDS.filter((f) => f.required && !answered(form[f.key]));
}

/**
 * Optional "About you" questions still blank — named rather than hidden.
 *
 * Each of these is a screening question the agent will refuse to answer on an
 * application that asks it, and the application waits instead of being sent.
 * That trade is the right one, but it is only fair if the user is told which
 * blanks are buying it.
 */
export function blankOptional(form: Record<string, unknown>): ProffField[] {
  return PROFF_FIELDS.filter(
    (f) =>
      !f.required &&
      (f.group === "About you" || f.group === "Education") &&
      !answered(form[f.key]),
  );
}
