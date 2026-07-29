import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import { CONSENT_VERSION } from "@/lib/readiness";

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });
  // Whitelist the user fields — never spread the raw row, which carries
  // passwordHash, googleId, tokenVersion and the Slack IDs. The profile relation
  // is the caller's own preferences and is safe to return whole.
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true, email: true, name: true, plan: true, paid: true, status: true,
      accessStatus: true, role: true, slackConnected: true, internshalaConnected: true,
      gmailScanInterest: true, createdAt: true,
      profile: true,
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { profile, ...safeUser } = user;
  return NextResponse.json({ user: safeUser, profile });
}

const ARRAY_FIELDS = new Set([
  "preferredDomains",
  "preferredLocations",
  "excludedCompanies",
  "skills",
]);
const NUM_FIELDS = new Set([
  "stipendMin", "minMatchScore", "maxPerDay", "matchQualityRating",
  // Eligibility facts the agent will state on screening forms (see lib/readiness).
  "gradYear", "gradMonth",
  // The rest of what a screening form asks and a resume never carries. Setup
  // collects them once so the agent stops stalling on the same questions —
  // agent/questions.py answers from these verbatim.
  "hoursPerWeek", "expectedStipend", "class10Percent", "class12Percent",
]);
const STR_FIELDS = new Set([
  "workMode",
  "experienceLevel",
  "resumeText",
  "resumeName",
  "education",
  // Stated verbatim on applications, never inferred.
  "availability",
  "workAuthorization",
  "timezone",
  // Split out of `education` because forms ask for them in separate boxes.
  "degree",
  "college",
  "willingToRelocate",
  // The questions a measured dry run showed were actually stalling unattended
  // applications — "current salary", "previous internship experience" — plus the
  // boxes Indian portals mark required. Stated verbatim like everything else
  // here; the agent invents none of them.
  "currentSalary",
  "previousInternship",
  "noticePeriod",
  "currentLocation",
  "dateOfBirth",
  "nationality",
  "gender",
  "differentlyAbled",
  // Its own box on most applications, so it isn't re-parsed out of the PDF.
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
  // lib/otp.ts + adapters/sms.ts (phone-verify OTP) exist but are wired to no
  // route, so there is no way to ever set phoneVerified — gating writes on
  // that flow just made the field permanently unfillable (readiness.ts blocks
  // auto-apply on it, and the resume auto-fill path writes straight to the DB
  // from the Python worker, bypassing this route entirely either way). Accept
  // it as plain text like the other stated-verbatim facts above.
  "phone",
]);
const BOOL_FIELDS = new Set(["autoApply"]);
const DECIMAL_FIELDS = new Set(["gpa", "class10Percent", "class12Percent"]);

// Fields whose value must be one of a fixed set — anything else is dropped, so a
// typo or a hostile body can't write a channel the worker doesn't know how to
// deliver on (which would silently mean no reports at all).
const ENUM_FIELDS: Record<string, Set<string>> = {
  reportChannel: new Set(["email", "slack"]),
  // A plain yes/no on every applicant tracking system. Constrained here because
  // the agent hands this straight to a Yes/No dropdown — anything else would be
  // stored, never match an option, and silently stall the application instead.
  needsSponsorship: new Set(["Yes", "No"]),
};

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // `name` lives on User, not Profile — readiness.ts requires it (forms ask
  // for a full name on nearly every submission) but nothing ever let a user
  // set it themselves; it only ever came from Google OAuth, and stayed null
  // forever for an account Google didn't return one for. Handled separately
  // from the Profile upsert below since it's a different table.
  if (typeof body.name === "string" && body.name.trim()) {
    await prisma.user.update({ where: { id: uid }, data: { name: body.name.trim().slice(0, 200) } });
  }

  const data: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(body)) {
    if (ARRAY_FIELDS.has(k)) data[k] = JSON.stringify(Array.isArray(v) ? v : []);
    // These need decimal precision (8.4/10, a 94.5% board result) — the rest of
    // NUM_FIELDS are genuine integers (day counts, a year, a match score), so
    // only these get 2dp instead of being rounded whole. A board percentage
    // rounded to 95 is a different, false, number on an application.
    else if (DECIMAL_FIELDS.has(k)) data[k] = Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
    else if (NUM_FIELDS.has(k)) data[k] = Math.max(0, Math.round(Number(v) || 0));
    else if (BOOL_FIELDS.has(k)) data[k] = Boolean(v);
    else if (ENUM_FIELDS[k]) { if (ENUM_FIELDS[k].has(String(v).trim())) data[k] = String(v).trim(); }
    // Trimmed, because every one of these is typed onto a real application
    // exactly as stored. A stray trailing space in "indian " is invisible in the
    // box the user typed it into and permanent on every form after that; worse,
    // agent/questions._fit_option matches a stored value against a form's own
    // dropdown options, and " Indian citizen " matches nothing.
    else if (STR_FIELDS.has(k)) data[k] = String(v ?? "").trim();
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });

  // Record explicit consent the moment the user enables auto-apply (audit trail
  // for "the agent applied on my behalf"). We stamp it on enable, together with
  // WHICH wording they agreed to — consent to v1 is not consent to v2, so
  // readiness re-checks the version and holds sends until they re-agree.
  if (data.autoApply === true) {
    data.autoApplyConsentAt = new Date();
    data.consentVersion = CONSENT_VERSION;
    await audit("consent", {
      userId: uid, detail: `auto_apply enabled (consent ${CONSENT_VERSION})`,
    });
  }
  // Revocation is a first-class event, not the absence of one. The timestamp
  // stays (it is the audit trail of what was true when past applications went
  // out); readiness fails on the toggle, which stops every future submission.
  if (data.autoApply === false) {
    await audit("consent", { userId: uid, detail: "auto_apply revoked" });
  }

  let profile = await prisma.profile.upsert({
    where: { userId: uid },
    update: data,
    create: { userId: uid, ...data },
  });

  // Keep the combined "course and college" line in step with its two halves.
  // Setup collects degree and college separately now (forms ask for them in
  // separate boxes), and nothing writes `education` directly any more — but
  // readiness, the agent's generic "Education" answer, and older rows all still
  // read it. Deriving it here means one save can't leave the two disagreeing.
  if (data.degree !== undefined || data.college !== undefined) {
    const composed = [profile.degree, profile.college].filter(Boolean).join(", ");
    if (composed && composed !== profile.education) {
      profile = await prisma.profile.update({
        where: { userId: uid },
        data: { education: composed },
      });
    }
  }
  return NextResponse.json({ ok: true, profile });
}
