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
  // lib/otp.ts + adapters/sms.ts (phone-verify OTP) exist but are wired to no
  // route, so there is no way to ever set phoneVerified — gating writes on
  // that flow just made the field permanently unfillable (readiness.ts blocks
  // auto-apply on it, and the resume auto-fill path writes straight to the DB
  // from the Python worker, bypassing this route entirely either way). Accept
  // it as plain text like the other stated-verbatim facts above.
  "phone",
]);
const BOOL_FIELDS = new Set(["autoApply"]);

// Fields whose value must be one of a fixed set — anything else is dropped, so a
// typo or a hostile body can't write a channel the worker doesn't know how to
// deliver on (which would silently mean no reports at all).
const ENUM_FIELDS: Record<string, Set<string>> = {
  reportChannel: new Set(["email", "slack"]),
};

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(body)) {
    if (ARRAY_FIELDS.has(k)) data[k] = JSON.stringify(Array.isArray(v) ? v : []);
    // GPA needs decimal precision (8.4/10, not 8) — every other NUM_FIELD is a
    // genuine integer (day counts, a year, a match-score), so it alone gets
    // rounded to 2dp instead of whole.
    else if (k === "gpa") data[k] = Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
    else if (NUM_FIELDS.has(k)) data[k] = Math.max(0, Math.round(Number(v) || 0));
    else if (BOOL_FIELDS.has(k)) data[k] = Boolean(v);
    else if (ENUM_FIELDS[k]) { if (ENUM_FIELDS[k].has(String(v))) data[k] = String(v); }
    else if (STR_FIELDS.has(k)) data[k] = String(v ?? "");
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

  const profile = await prisma.profile.upsert({
    where: { userId: uid },
    update: data,
    create: { userId: uid, ...data },
  });
  return NextResponse.json({ ok: true, profile });
}
