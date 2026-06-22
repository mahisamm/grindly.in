import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

// Full application history for the logged-in user, with the immutable resume
// snapshot attached so the dashboard can show "exactly what the recruiter saw".
export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const apps = await prisma.application.findMany({
    where: { userId: uid },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      resumeVersion: {
        select: { id: true, label: true, skillsClaimed: true, baseSkills: true, filePath: true },
      },
    },
  });

  return NextResponse.json({ applications: apps });
}
