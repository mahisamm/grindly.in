import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { FREE_TRIAL_APPLICATIONS } from "@/lib/plans";
import { hasAppAccess } from "@/lib/access";
import { computeReadiness } from "@/lib/readiness";

/** Activate the free plan (free beta). Grants the free daily allowance
 * (5 applications/day); it never masquerades as a paid Plus/Pro subscription. */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const existing = await prisma.user.findUnique({
    where: { id: uid },
    include: { profile: true },
  });
  if (!existing) return NextResponse.json({ error: "user not found" }, { status: 404 });
  if (!hasAppAccess(existing)) {
    return NextResponse.json(
      { error: "Your access is pending approval.", code: "access_pending" },
      { status: 403 },
    );
  }
  // Activation is the moment the agent is allowed to act. Refuse it until the
  // facts it will state and the consent to state them both exist — otherwise a
  // user "activates", the worker holds every send on readiness, and the product
  // looks broken when it is in fact protecting them. Same computation the
  // worker re-runs before dispatch, so the two can never disagree.
  const readiness = computeReadiness(existing);
  if (!readiness.ready) {
    return NextResponse.json(
      {
        error: "Finish your setup before activating auto-apply.",
        code: "setup_incomplete",
        missing: readiness.missing,
        checks: readiness.checks,
      },
      { status: 409 },
    );
  }
  if (existing.paid) {
    return NextResponse.json({ error: "A paid plan is already active." }, { status: 409 });
  }

  await prisma.user.update({
    where: { id: uid },
    data: {
      paid: false,
      plan: "free",
      status: "active",
      profile: existing.profile
        ? { update: { maxPerDay: FREE_TRIAL_APPLICATIONS } }
        : {
            create: {
              maxPerDay: FREE_TRIAL_APPLICATIONS,
              skills: "[]",
              preferredDomains: "[]",
              preferredLocations: "[]",
              excludedCompanies: "[]",
            },
          },
    },
  });

  return NextResponse.json({ ok: true, applications: FREE_TRIAL_APPLICATIONS });
}
