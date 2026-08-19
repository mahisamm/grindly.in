import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["sent", "screening", "interview", "offer", "rejected", "withdrawn"] as const;
type Status = (typeof STATUSES)[number];

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** Everything this user has sent, newest first. */
export async function GET(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  const resumeId = new URL(req.url).searchParams.get("resumeId");

  const applications = await prisma.application.findMany({
    where: { userId: auth.user.id, ...(resumeId ? { resumeId } : {}) },
    orderBy: { appliedAt: "desc" },
    take: 500,
  });

  return NextResponse.json({ ok: true, applications });
}

/**
 * Record an application.
 *
 * Grindly does not submit anything and does not read anyone's inbox — bulk
 * submission through job boards breaks their terms and gets user accounts
 * banned, which is the decision this whole product is shaped around. So every
 * row here is typed by the person who sent it.
 *
 * What earns it a place in the database rather than in a spreadsheet is one
 * column: which VERSION of the resume went out. That is a join this schema can
 * make and a spreadsheet cannot, and it turns "I applied to 40 places" into
 * "the tailored one got three replies out of nine and the generic one got none
 * out of thirty-one".
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  let body: {
    resumeId?: string;
    company?: string;
    role?: string;
    variantLabel?: string;
    status?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const company = String(body.company ?? "").trim().slice(0, 120);
  if (!company) return badRequest("Which company did you send it to?");

  const resumeId = String(body.resumeId ?? "");
  // Ownership through the resume, in the WHERE — a resume id from another
  // account must read as "no such resume", not as a permission error.
  const resume = await prisma.resume.findFirst({
    where: { id: resumeId, userId: auth.user.id },
    select: { id: true },
  });
  if (!resume) return notFound();

  try {
    const application = await prisma.application.create({
      data: {
        userId: auth.user.id,
        resumeId: resume.id,
        company,
        role: String(body.role ?? "").trim().slice(0, 120),
        variantLabel: String(body.variantLabel ?? "").trim().slice(0, 60) || null,
        status: isStatus(body.status) ? body.status : "sent",
        notes: String(body.notes ?? "").trim().slice(0, 2000) || null,
      },
    });
    await audit(auth.user.id, "application_logged", application.id, company);
    return NextResponse.json({ ok: true, application });
  } catch (e) {
    return serverError("Could not save that.", `applications: ${String(e)}`);
  }
}
