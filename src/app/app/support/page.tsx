import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { SupportDesk } from "./SupportDesk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support — Grindly" };

/**
 * The user's support desk: their conversations, and the door to a new one.
 * There is no form and no category picker — the assistant IS the front door
 * (lib/tickets.ts), carrying the product notes in lib/support.ts and handing
 * over to a person when it matters.
 */
export default async function SupportPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const tickets = await prisma.ticket.findMany({
    where: { userId: user.id },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: {
      id: true, category: true, subject: true, status: true, handledBy: true,
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
        Talk to us. Grindly&rsquo;s assistant answers straight away, knows the product, and hands
        you to a person on the team when it matters — or the moment you ask. You get an email
        when a person replies. For a one-way note that needs no answer, use{" "}
        <b>Contact &amp; feedback</b> in the account menu.
      </p>
      <SupportDesk
        tickets={tickets.map((t) => ({
          id: t.id,
          category: t.category,
          subject: t.subject,
          status: t.status,
          handledBy: t.handledBy,
          createdAt: t.createdAt.toISOString(),
          lastMessageAt: t.lastMessageAt.toISOString(),
          unread: t.lastMessageBy !== "user" && (!t.userSeenAt || t.userSeenAt < t.lastMessageAt),
        }))}
      />
    </div>
  );
}
