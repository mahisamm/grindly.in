import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { computeReadiness, CONSENT_VERSION, CONSENT_TEXT } from "@/lib/readiness";

// GET /api/profile/readiness — can the agent act for me yet, and if not, what
// exactly is missing? The dashboard checklist, the onboarding gate, and the
// activation route all read this same computation, so the UI can never promise
// an autopilot the worker will refuse to run.
export const dynamic = "force-dynamic";

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      name: true,
      email: true,
      profile: {
        select: {
          resumeName: true, phone: true, education: true, gradYear: true,
          preferredDomains: true, autoApply: true, autoApplyConsentAt: true,
          consentVersion: true, maxPerDay: true, timezone: true,
        },
      },
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  const readiness = computeReadiness(user);
  return NextResponse.json({
    ...readiness,
    consent: {
      version: CONSENT_VERSION,
      text: CONSENT_TEXT,
      // True only for the CURRENT wording — an older acceptance reads as not
      // accepted, which is what forces a re-agree when the promise changes.
      accepted: user.profile?.consentVersion === CONSENT_VERSION,
      acceptedAt: user.profile?.autoApplyConsentAt ?? null,
    },
  });
}
