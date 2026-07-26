import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateExtension } from "@/lib/extensionAuth";
import { claimNextTask, HEARTBEAT_MS, localDateFor } from "@/lib/browserTasks";
import { buildKit } from "@/lib/applyKit";
import { computeReadiness } from "@/lib/readiness";
import { browserExecutorEnabled } from "@/lib/serverConfig";

// POST /api/extension/tasks/claim — lease one application for this browser.
//
// Returns the task and the fields needed to fill it. Never returns credentials,
// cookies or anything about another user: the extension works inside the
// session the person is already signed into, and this payload is only the facts
// they approved for their own applications.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await authenticateExtension(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Fleet switch first: an operator turning the executor off must stop new work
  // immediately, without needing every extension to update.
  if (!browserExecutorEnabled()) {
    return NextResponse.json({ task: null, reason: "executor_disabled" });
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: {
      name: true, email: true,
      profile: {
        select: {
          resumeName: true, phone: true, education: true, gradYear: true,
          gradMonth: true, availability: true, workAuthorization: true, gpa: true,
          preferredDomains: true, autoApply: true, autoApplyConsentAt: true,
          consentVersion: true, maxPerDay: true, timezone: true,
        },
      },
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Readiness is re-checked HERE, not trusted from when the task was created.
  // Consent can be revoked between queueing and execution, and the check that
  // runs closest to the submit is the only one that actually protects anyone.
  const readiness = computeReadiness(user);
  if (!readiness.ready) {
    return NextResponse.json({ task: null, reason: "not_ready", missing: readiness.missing });
  }

  const p = user.profile!;
  // The cap is enforced here, at the moment work is handed out, because the
  // browser can submit as soon as it has a task.
  const { task, reason } = await claimNextTask(
    auth.userId, p.maxPerDay ?? 0, localDateFor(p.timezone),
  );
  if (!task) return NextResponse.json({ task: null, reason });

  // The per-job draft: the cover letter and the answers the user approved for
  // THIS employer, not just their standing facts.
  const app = await prisma.application
    .findUnique({
      where: { id: task.applicationId },
      select: { coverLetterText: true, answersJson: true },
    })
    .catch(() => null);

  return NextResponse.json({
    task: {
      id: task.id,
      url: task.url,
      // The extension refuses to navigate off this host, so a leaked lease
      // cannot be used to drive someone's browser somewhere else.
      host: task.host,
      leaseToken: task.leaseToken,
      leaseExpiresAt: task.leaseExpiresAt,
      heartbeatMs: HEARTBEAT_MS,
    },
    // Facts only, and only this user's own, in the one shape fillEngine reads.
    // Anything not here is a question the extension must stop and ask about
    // rather than guess at.
    kit: buildKit(user, app),
  });
}
