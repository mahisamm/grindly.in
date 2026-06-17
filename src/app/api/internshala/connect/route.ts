import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

/** Launches a visible browser (connect_internshala.py) so the user logs into
 *  Internshala once. The script flips users.internshala_connected when done. */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  const root = process.cwd();
  const script = path.join(root, "agent", "connect_internshala.py");
  if (!fs.existsSync(script)) {
    return NextResponse.json({ error: "connect script missing" }, { status: 500 });
  }

  const logDir = path.join(root, "data", "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${uid}-connect.log`), "a");

  const py = process.env.PYTHON_BIN || "python";
  const child = spawn(py, [script, "--user", uid, "--timeout", "300"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  return NextResponse.json({ ok: true, pid: child.pid });
}
