import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, serverError } from "@/lib/auth";
import { RESUME_DIR, VARIANT_DIR } from "@/lib/agent";
import {
  readAdvice, readContact, readFidelity, readReport, readStrings, readTargetSpec,
} from "@/lib/reportTypes";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** One resume with its report, variants and targets. */
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    // userId in the WHERE, not checked afterwards. An ownership test written as
    // `findUnique` then `if (row.userId !== me)` is one early return away from
    // leaking, and it leaks the whole row when it does.
    where: { id, userId: auth.user.id },
    include: {
      variants: {
        where: { archivedAt: null },
        orderBy: [{ beatsBaseline: "desc" }, { score: "desc" }],
      },
      targets: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!resume) return notFound();

  return NextResponse.json({
    ok: true,
    resume: {
      ...resume,
      // Validated here, once, so no client repeats the guard and none of them
      // has to decide what to do with a column that does not hold what it says.
      report: readReport(resume.reportJson),
      advice: readAdvice(resume.adviceJson),
      contact: readContact(resume.contactJson),
      links: readStrings(resume.linksJson),
      skills: readStrings(resume.skillsJson),
      variants: resume.variants.map((v) => ({
        ...v,
        changes: readStrings(v.changesJson),
        report: readReport(v.reportJson),
        fidelity: readFidelity(v.fidelityJson),
      })),
      targets: resume.targets.map((t) => ({ ...t, spec: readTargetSpec(t.specJson) })),
    },
  });
}

/** Delete a resume, its variants, and every file either produced. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true, ext: true },
  });
  if (!resume) return notFound();

  try {
    // Rows first. If the filesystem cleanup fails afterwards we are left with
    // orphaned bytes, which a sweep can find; the reverse order leaves rows
    // pointing at files that no longer exist, which the UI renders as a broken
    // download the user cannot get rid of.
    await prisma.resume.delete({ where: { id: resume.id } });
  } catch (e) {
    console.error("[resumes] delete failed:", e);
    return serverError("Could not delete that resume.");
  }

  if (resume.ext) {
    await fsp.rm(path.join(RESUME_DIR, `${resume.id}${resume.ext}`), { force: true }).catch(() => {});
  }
  await fsp.rm(path.join(VARIANT_DIR, resume.id), { recursive: true, force: true }).catch(() => {});

  await audit(auth.user.id, "resume_delete", resume.id);
  return NextResponse.json({ ok: true });
}

/** Rename. The only editable field on a resume — the text comes from the file. */
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }
  const label = (body.label ?? "").trim().slice(0, 80);
  if (!label) return NextResponse.json({ error: "Give it a name." }, { status: 400 });

  const updated = await prisma.resume.updateMany({
    where: { id, userId: auth.user.id },
    data: { label },
  });
  if (updated.count === 0) return notFound();
  return NextResponse.json({ ok: true, label });
}
