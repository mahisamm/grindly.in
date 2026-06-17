import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: uid }, include: { profile: true } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ user, profile: user.profile });
}

const ARRAY_FIELDS = new Set([
  "preferredDomains",
  "preferredLocations",
  "excludedCompanies",
  "skills",
]);
const NUM_FIELDS = new Set(["stipendMin", "minMatchScore", "maxPerDay"]);
const STR_FIELDS = new Set([
  "workMode",
  "experienceLevel",
  "resumeText",
  "resumeName",
  "education",
]);
const BOOL_FIELDS = new Set(["autoApply"]);

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(body)) {
    if (ARRAY_FIELDS.has(k)) data[k] = JSON.stringify(Array.isArray(v) ? v : []);
    else if (NUM_FIELDS.has(k)) data[k] = Math.max(0, Math.round(Number(v) || 0));
    else if (BOOL_FIELDS.has(k)) data[k] = Boolean(v);
    else if (STR_FIELDS.has(k)) data[k] = String(v ?? "");
  }

  const profile = await prisma.profile.update({ where: { userId: uid }, data });
  return NextResponse.json({ ok: true, profile });
}
