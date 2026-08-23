import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { SupportDesk } from "./SupportDesk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support — Grindly" };

/**
 * The user's support desk: their tickets, and the form to raise one.
 *
 * The form leads with self-help for the chosen category BEFORE the text box
 * (see lib/support.ts). Most "it failed" tickets are resolved by the sentence
 * that says "press Rebuild once more — you were not charged"; showing that
 * first is faster than any reply, and the tickets that do get raised are the
 * ones that genuinely need a person.
 */
export default async function SupportPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const tickets = await prisma.ticket.findMany({
    where: { userId: user.id },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: {
      id: true, category: true, subject: true, status: true,
      createdAt: true, lastMessageAt: true, lastMessageBy: true, userSeenAt: true,
    },
  });

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-6 sm:py-10">
      <Link href="/app" className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm">
        ← Back to dashboard
      </Link>
      <h1 className="font-display mt-3 text-2xl font-bold sm:text-3xl">Support</h1>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        A ticket is a conversation with us — we reply here, and you get an email when we
        do. For a quick note that needs no answer, use <b>Send feedback</b> in the account
        menu instead.
      </p>
      <SupportDesk
        tickets={tickets.map((t) => ({
          id: t.id,
          category: t.category,
          subject: t.subject,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
          lastMessageAt: t.lastMessageAt.toISOString(),
          unread: t.lastMessageBy === "admin" && (!t.userSeenAt || t.userSeenAt < t.lastMessageAt),
        }))}
      />
    </div>
  );
}
