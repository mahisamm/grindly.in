import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { writeAdminSettings } from "@/lib/adminSettings";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Flip one of the two global switches. Body is `{ signupsPaused: boolean }`
 * or `{ rebuildsPaused: boolean }` — one key, so a stray field in the body
 * can never flip a switch nobody asked to touch.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: { signupsPaused?: boolean; rebuildsPaused?: boolean } = {};
  if (typeof body.signupsPaused === "boolean") patch.signupsPaused = body.signupsPaused;
  if (typeof body.rebuildsPaused === "boolean") patch.rebuildsPaused = body.rebuildsPaused;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Send signupsPaused or rebuildsPaused as a boolean." }, { status: 400 });
  }

  const updated = writeAdminSettings(patch);
  await audit(
    auth.user.id,
    "settings_update",
    undefined,
    Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join(", "),
  );
  return NextResponse.json({ ok: true, settings: updated });
}
