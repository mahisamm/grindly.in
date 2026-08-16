import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { daysRemaining, effectivePlan, limitsFor } from "@/lib/plans";
import { usageToday } from "@/lib/quota";
import { describe } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who am I, what can I do, and what has this server got switched on.
 *
 * The capability half is computed server-side and returned here rather than
 * baked into NEXT_PUBLIC_ variables. A NEXT_PUBLIC_ flag is fixed at build
 * time, so a Docker image built with payments off keeps showing them off after
 * the operator sets the key — the previous build hit exactly that and the fix
 * was to move the decision here.
 */
export async function GET() {
  const user = await currentUser();
  const caps = describe();

  const server = {
    googleAuth: caps.auth.google,
    payments: caps.payments.enabled,
    rewrites: caps.llmProviders.length > 0,
  };

  if (!user) {
    return NextResponse.json({ ok: true, user: null, server });
  }

  const plan = effectivePlan(user);
  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan,
      daysRemaining: daysRemaining(user),
    },
    limits: limitsFor(user),
    usage: await usageToday(user.id),
    server,
  });
}
