import { NextResponse } from "next/server";
import { requireApprovedUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { toJsonColumn } from "@/lib/jsonColumn";
import { formatLimit, limitsFor } from "@/lib/plans";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STARTER = {
  name: "",
  contact_line: "",
  sections: [
    { heading: "Education", items: [{ head: "", sub: "", bullets: [] }] },
    { heading: "Experience", items: [{ head: "", sub: "", bullets: [""] }] },
    { heading: "Projects", items: [{ head: "", sub: "", bullets: [""] }] },
    { heading: "Technical Skills", items: [{ head: "", sub: "", bullets: [""] }] },
  ],
};

/** Start an editable resume without pretending an upload exists. */
export async function POST() {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const limit = limitsFor(user).resumes;
  const count = await prisma.resume.count({ where: { userId: user.id } });
  if (count >= limit) {
    return NextResponse.json(
      {
        error: `Your plan holds ${formatLimit(limit)} resumes. Delete one, or get a Season Pass.`,
        code: "plan_limit",
      },
      { status: 402 },
    );
  }

  const resume = await prisma.$transaction(async (tx) => {
    const created = await tx.resume.create({
      data: {
        userId: user.id,
        label: "My first resume",
        originalName: null,
        ext: null,
        structJson: toJsonColumn(STARTER),
      },
      select: { id: true },
    });
    if (!user.primaryResumeId) {
      await tx.user.update({ where: { id: user.id }, data: { primaryResumeId: created.id } });
    }
    return created;
  });

  await audit(user.id, "resume_created", resume.id, "from scratch");
  return NextResponse.json({ ok: true, id: resume.id }, { status: 201 });
}
