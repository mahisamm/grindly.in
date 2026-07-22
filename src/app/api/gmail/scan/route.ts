import { NextResponse } from "next/server";
import path from "node:path";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { enqueueAgentRun } from "@/lib/agentRunQueue";
import { spawnWorkerKick } from "@/lib/workerKick";
import { gmailScanEnabled } from "@/lib/googleOAuth";

export const dynamic = "force-dynamic";

/**
 * Manual "Scan now" for Gmail interview detection.
 *
 * This used to shell out to Python (email_scanner.py) from the web process, which
 * the slim production image can't do (no Python, no LLM) — so it 503'd in prod and
 * only ever worked on a dev box. Now it just ENQUEUES a `scan_email` worker job,
 * exactly like resume analysis: the worker fleet holds the Python + LLM the scan
 * needs, drains the job, updates outcomes, and notifies the user. Works in dev and
 * prod alike; the daily sweep enqueues the same job on its own, so this button is a
 * convenience, not the only path.
 */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  // Feature gate — gmail.readonly is a Google-restricted scope. Until it clears
  // verification the whole flow is dark and there is nothing to scan.
  if (!gmailScanEnabled()) {
    return NextResponse.json(
      { error: "Gmail interview detection isn't switched on yet." },
      { status: 503 },
    );
  }

  const cred = await prisma.platformCredential
    .findUnique({ where: { userId_platform: { userId: uid, platform: "gmail" } } })
    .catch(() => null);
  if (!cred) return NextResponse.json({ error: "Gmail not connected" }, { status: 400 });

  try {
    await enqueueAgentRun(uid, "scan_email");
  } catch (e) {
    console.error("[gmail/scan] enqueue failed:", e);
    return NextResponse.json({ error: "Couldn't start the scan — please try again." }, { status: 500 });
  }

  // Best-effort local kick so a dev box scans immediately; no-ops in the slim
  // prod image, where the worker fleet drains the queued job.
  const worker = path.join(process.cwd(), "agent", "worker.py");
  try {
    await fsp.access(worker);
    spawnWorkerKick(process.cwd(), uid);
  } catch {
    // No Python here — the worker drains the queued scan.
  }

  return NextResponse.json({ ok: true, queued: true });
}
