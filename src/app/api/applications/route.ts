import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { visibleToUser } from "@/lib/pipeline";

// The user's application history, with the immutable resume snapshot attached so
// they can see exactly what a recruiter received before an interview call.
//
// Future-dated matches are withheld — see lib/pipeline.ts for why. The client
// cannot opt out of that: ?status=matched still only returns the ones due today.
//
// Pagination and the status filter used to be accepted by the UI and silently
// ignored here (the handler took a flat 200 rows), so the filter buttons on
// /applications did nothing and page 2 showed page 1.
const PAGE_SIZE_MAX = 50;

// Statuses a client may filter by. "matched" is allowed but is still subject to
// the due-date gate above.
const FILTERABLE = new Set([
  "applied", "matched", "approved", "submitting", "skipped", "failed", "needs_review",
]);

export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number(url.searchParams.get("pageSize")) || 20),
  );
  const status = url.searchParams.get("status") ?? "";

  const where = visibleToUser(uid);
  if (status && FILTERABLE.has(status)) {
    // AND with the visibility rule rather than replacing it — a status filter must
    // never be able to widen what the user can see.
    Object.assign(where, { AND: [{ status }] });
  }

  const [total, apps] = await Promise.all([
    prisma.application.count({ where }),
    prisma.application.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        resumeVersion: {
          select: {
            id: true, label: true, skillsClaimed: true, baseSkills: true,
            filePath: true, tailored: true, fitScore: true,
          },
        },
      },
    }),
  ]);

  return NextResponse.json({
    applications: apps,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
