import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { pickPrimary } from "@/lib/primary";

export const dynamic = "force-dynamic";

/**
 * The front door after sign-in: straight to the resume you are sending.
 *
 * This used to render the library — every resume as a card, plus a drop zone
 * — and testers found it confusing: they signed in to work on THEIR resume
 * and met a grid instead. The dashboard is the primary resume's workspace
 * (score, report, rewrites, targets); the library moved to /app/resumes and
 * is one tap away from the avatar menu, the phone bar, and every workspace's
 * back link. An account with nothing uploaded yet goes to the library, whose
 * empty state is the upload itself.
 */
export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const resumes = await prisma.resume.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const primary = pickPrimary(resumes, user.primaryResumeId);
  redirect(primary ? `/app/${primary.id}` : "/app/resumes");
}
