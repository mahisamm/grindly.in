import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { encryptSecret } from "@/lib/crypto";
import { internshalaLoginEnabled } from "@/lib/featureFlags";

const PLATFORM = "internshala";

const Body = z.object({
  email: z.string().trim().email("Enter a valid email."),
  password: z.string().min(1, "Password is required.").max(200),
  consent: z.literal(true, { message: "Please authorize Grindly to apply on your behalf." }),
});

/**
 * POST /api/integrations/internshala/credentials  body: { email, password }
 *
 * Hosted login path: the browser lives on the server, so we can't pop a window
 * for the user. They submit their Internshala credentials here; we store them
 * AES-256-GCM encrypted (never plaintext) and enqueue a `connect_internshala`
 * run. A worker logs in headless on the shared profile and flips the integration
 * to `connected` (or `otp_required` if Internshala asks for a one-time code).
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Staged rollout gate — enforced server-side, not just hidden in the UI.
  if (!internshalaLoginEnabled(user)) {
    return NextResponse.json(
      { error: "Internshala auto-apply is rolling out — your account isn't enabled yet." },
      { status: 403 },
    );
  }

  // Record the auto-apply consent timestamp (also unblocks the worker, which
  // refuses to submit applications without an explicit consent on record).
  await prisma.profile.updateMany({
    where: { userId: uid },
    data: { autoApplyConsentAt: new Date() },
  });

  // Encrypt the credential bundle. Decrypted only inside the worker at login time.
  const ciphertext = encryptSecret(JSON.stringify({ email, password }));

  await prisma.platformCredential.upsert({
    where: { userId_platform: { userId: uid, platform: PLATFORM } },
    update: { ciphertext },
    create: { userId: uid, platform: PLATFORM, ciphertext },
  });

  // Reset the integration to a fresh "connecting" state (clear any prior OTP/error).
  await prisma.userIntegration.upsert({
    where: { userId_platform: { userId: uid, platform: PLATFORM } },
    update: { status: "connecting", otpRequired: false, otpCode: null, lastError: null },
    create: { userId: uid, platform: PLATFORM, status: "connecting" },
  });

  // Enqueue the login run (idempotent: reuse any in-flight connect run).
  const existing = await prisma.agentRun.findFirst({
    where: { userId: uid, mode: "connect_internshala", status: { in: ["queued", "running"] } },
  });
  const run = existing ?? (await prisma.agentRun.create({
    data: { userId: uid, mode: "connect_internshala" },
  }));

  // Best-effort local worker kick (no-op in the slim prod web image; the worker
  // fleet drains the queue regardless).
  try {
    const root = process.cwd();
    const worker = path.join(root, "agent", "worker.py");
    if (fs.existsSync(worker)) {
      const logDir = path.join(root, "data", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, `${uid}-connect.log`), "a");
      const py = process.env.PYTHON_BIN || "python";
      const child = spawn(py, [worker, "--drain"], { cwd: root, detached: true, stdio: ["ignore", out, out] });
      fs.closeSync(out);
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    // Worker drains the queue — kick is only a dev convenience.
  }

  return NextResponse.json({ ok: true, runId: run.id });
}

/**
 * DELETE /api/integrations/internshala/credentials — forget the saved
 * credentials and mark the platform disconnected.
 */
export async function DELETE() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  await prisma.platformCredential.deleteMany({ where: { userId: uid, platform: PLATFORM } });
  await prisma.userIntegration.updateMany({
    where: { userId: uid, platform: PLATFORM },
    data: { status: "disconnected", otpRequired: false, otpCode: null, lastError: null },
  });
  await prisma.user.update({ where: { id: uid }, data: { internshalaConnected: false } });

  return NextResponse.json({ ok: true });
}
