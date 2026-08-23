import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { loadTicket, markSeen, actorOf } from "@/lib/tickets";
import { TicketThread } from "@/components/TicketThread";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket — Grindly" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected
  const { id } = await params;
  const actor = actorOf(user);
  const ticket = await loadTicket(id, actor);
  if (!ticket) notFound();
  if (ticket.unread) await markSeen(id, actor);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10">
      <TicketThread initial={ticket} viewer="user" backHref="/app/support" backLabel="All conversations" />
    </div>
  );
}
