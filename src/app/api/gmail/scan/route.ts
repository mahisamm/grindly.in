import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { decryptSecret } from "@/lib/crypto";
import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  // Gmail scan shells out to Python (email_scanner.py). The slim prod web image
  // has no Python, so disable it in production until the scan runs on the worker
  // (Phase 4). Outcomes can still be set manually in the dashboard.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Gmail interview-detection isn't available in the hosted beta yet." },
      { status: 503 },
    );
  }

  // Check Gmail connected
  const cred = await prisma.platformCredential.findUnique({
    where: { userId_platform: { userId: uid, platform: "gmail" } },
  });
  if (!cred) return NextResponse.json({ error: "Gmail not connected" }, { status: 400 });

  // Decrypt token
  const tokens = JSON.parse(decryptSecret(cred.ciphertext)) as { refresh_token: string };

  // Write tokens to a temp file for the Python script to read
  const tmpPath = path.join(process.cwd(), "data", `gmail_scan_${uid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({ userId: uid, refresh_token: tokens.refresh_token }), "utf8");

  try {
    const bin = process.env.PYTHON_BIN ?? "python";
    const script = path.join(process.cwd(), "agent", "email_scanner.py");
    const agentDir = path.join(process.cwd(), "agent");
    const out = execFileSync(bin, [script, tmpPath], {
      timeout: 60_000,
      cwd: agentDir,
      env: { ...process.env },
    }).toString();
    fs.unlinkSync(tmpPath);

    let result: { scanned: number; detected: { appId: string; outcome: string; subject: string }[] } = { scanned: 0, detected: [] };
    try { result = JSON.parse(out.trim().split("\n").filter(l => l.startsWith("{")).pop() ?? "{}"); } catch {}

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    // Log the detail server-side only — don't leak internal paths/stack to client.
    console.error("[gmail/scan] failed:", e);
    return NextResponse.json({ error: "Scan failed" }, { status: 500 });
  }
}
