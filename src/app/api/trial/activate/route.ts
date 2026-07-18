import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { FREE_TRIAL_APPLICATIONS } from "@/lib/plans";

/** Activate the one-time free trial. It grants five successful applications
 * total; it never masquerades as a paid Plus/Pro subscription. */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const existing = await prisma.user.findUnique({
    where: { id: uid },
    include: { profile: true },
  });
  if (!existing) return NextResponse.json({ error: "user not found" }, { status: 404 });
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
