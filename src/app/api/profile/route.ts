import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: uid }, include: { profile: true } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ user, profile: user.profile });
}

const ARRAY_FIELDS = new Set([
  "preferredDomains",
  "preferredLocations",
  "excludedCompanies",
  "skills",
]);
const NUM_FIELDS = new Set(["stipendMin", "minMatchScore", "maxPerDay", "gpa", "matchQualityRating"]);
// NOTE: `phone` is deliberately NOT here. Phone changes must go through the OTP
// verify flow (which sets phoneVerified) — letting profile overwrite it would
// keep a "verified" flag on an unverified number and reroute login OTPs.
const STR_FIELDS = new Set([
  "workMode",
  "experienceLevel",
  "resumeText",
  "resumeName",
  "education",
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
    else if (NUM_FIELDS.has(k)) data[k] = Math.max(0, Math.round(Number(v) || 0));
    else if (BOOL_FIELDS.has(k)) data[k] = Boolean(v);
    else if (ENUM_FIELDS[k]) { if (ENUM_FIELDS[k].has(String(v))) data[k] = String(v); }
    else if (STR_FIELDS.has(k)) data[k] = String(v ?? "");
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });

  // Record explicit consent the moment the user enables auto-apply (audit trail
  // for "the agent applied on my behalf"). We stamp it on enable and never
  // silently clear it.
  if (data.autoApply === true) {
    data.autoApplyConsentAt = new Date();
    await audit("consent", { userId: uid, detail: "auto_apply enabled" });
  }

  const profile = await prisma.profile.upsert({
    where: { userId: uid },
    update: data,
    create: { userId: uid, ...data },
  });
  return NextResponse.json({ ok: true, profile });
}
