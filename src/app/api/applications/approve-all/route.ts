import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";

/** Approve every matched application and enqueue ONE submit-only run to send
 *  them. See api/applications/approve for why the run is needed at all. */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const matched = await prisma.application.findMany({
    where: { userId: uid, status: "matched" },
    select: { id: true, reason: true },
  });
  if (matched.length === 0) return NextResponse.json({ ok: true, approved: 0 });

  await prisma.$transaction(
    matched.map((a) =>
      prisma.application.update({
        where: { id: a.id },
        data: { status: "approved", reason: (a.reason ?? "") + " — approved by you" },
      })
    )
  );

  const existing = await prisma.agentRun.findFirst({
    where: { userId: uid, status: { in: ["queued", "running"] } },
  });
  const run = existing ?? (await prisma.agentRun.create({ data: { userId: uid, mode: "approved" } }));
  spawnWorkerKick(process.cwd(), uid);

  return NextResponse.json({ ok: true, approved: matched.length, runId: run.id });
}
