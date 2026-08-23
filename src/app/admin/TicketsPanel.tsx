import Link from "next/link";
import type { TicketStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { loadTicket, markSeen, actorOf } from "@/lib/tickets";
import { STATUS_LABEL, categoryLabel } from "@/lib/support";
import { TicketThread } from "@/components/TicketThread";
import { Section, StatGrid, Stat } from "./Panels";

const FILTERS: { key: string; label: string; where: { status?: TicketStatus | { not: TicketStatus } } }[] = [
  { key: "queue", label: "Needs a reply", where: { status: { not: "closed" } } },
  { key: "open", label: "Open", where: { status: "open" } },
  { key: "answered", label: "Answered", where: { status: "answered" } },
  { key: "closed", label: "Closed", where: { status: "closed" } },
  { key: "all", label: "All", where: {} },
];

/**
 * The operator's ticket desk. List by default; `?t=<id>` opens one thread in
 * place, with the same chat component the user sees from their side. Opening
 * a thread marks it read for the operator, which is what clears the badge.
 */
export async function TicketsPanel({
  ticketId,
  status,
  adminUser,
}: {
  ticketId?: string;
  status?: string;
  adminUser: SessionUser;
}) {
  if (ticketId) {
    const actor = actorOf(adminUser);
    const ticket = await loadTicket(ticketId, actor);
    if (!ticket) {
      return (
        <Section title="Ticket" note="">
          <p className="text-muted mt-3 text-sm">
            No such ticket.{" "}
            <Link href="/admin?s=tickets" className="text-brand underline">
              Back to the list
            </Link>
          </p>
        </Section>
      );
    }
    if (ticket.unread) await markSeen(ticketId, actor);
    return (
      <div className="bg-surface border-border rounded-xl border p-5 sm:p-6">
        <TicketThread initial={ticket} viewer="admin" backHref="/admin?s=tickets" backLabel="All tickets" />
      </div>
    );
  }

  const filter = FILTERS.find((f) => f.key === status) ?? FILTERS[0];
  const [rows, counts] = await Promise.all([
    prisma.ticket.findMany({
      where: filter.key === "queue" ? { status: { not: "closed" }, lastMessageBy: "user" } : filter.where,
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      select: {
        id: true, category: true, subject: true, status: true,
        lastMessageAt: true, lastMessageBy: true, adminSeenAt: true, createdAt: true,
        user: { select: { email: true } },
        _count: { select: { messages: true } },
      },
    }),
    Promise.all([
      prisma.ticket.count({ where: { status: { not: "closed" }, lastMessageBy: "user" } }),
      prisma.ticket.count({ where: { status: "open" } }),
      prisma.ticket.count({ where: { status: "answered" } }),
      prisma.ticket.count({ where: { status: "closed" } }),
    ]),
  ]);
  const [queue, open, answered, closed] = counts;

  return (
    <Section
      title="Tickets"
      note="Raised by users from Support in their account menu. 'Needs a reply' is every ticket where the user spoke last. Opening one marks it read; your reply sets it to Answered and emails the user; their reply reopens it."
    >
      <StatGrid>
        <Stat label="Needs a reply" value={queue} tone={queue > 0 ? "warn" : undefined} sub="user spoke last" />
        <Stat label="Open" value={open} />
        <Stat label="Answered" value={answered} sub="waiting on the user" />
        <Stat label="Closed" value={closed} />
      </StatGrid>

      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter tickets">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/admin?s=tickets&status=${f.key}`}
            aria-current={filter.key === f.key ? "page" : undefined}
            className="rounded-full border px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] uppercase"
            style={
              filter.key === f.key
                ? { background: "var(--cta)", color: "var(--on-cta)", borderColor: "var(--cta)" }
                : { color: "var(--muted)", borderColor: "var(--line-2)" }
            }
          >
            {f.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-muted mt-4 text-sm">Nothing here.</p>
      ) : (
        <ul className="mt-3 divide-y rounded-xl border" style={{ borderColor: "var(--border)" }}>
          {rows.map((t) => {
            const unread = t.lastMessageBy === "user" && (!t.adminSeenAt || t.adminSeenAt < t.lastMessageAt);
            return (
              <li key={t.id}>
                <Link
                  href={`/admin?s=tickets&t=${t.id}`}
                  className="hover:bg-surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      {unread && (
                        <span
                          aria-label="Unread"
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: "var(--vermilion)" }}
                        />
                      )}
                      <span className={`truncate ${unread ? "font-semibold" : ""}`}>{t.subject}</span>
                    </span>
                    <span className="text-muted mt-0.5 block font-mono text-[10px] tracking-[0.1em] uppercase">
                      {t.user.email} · {categoryLabel(t.category)} · {t._count.messages} msg ·{" "}
                      {t.lastMessageAt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                  <span
                    className="rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
                    style={{
                      background: "var(--surface-2)",
                      color: t.status === "closed" ? "var(--muted)" : "var(--brand)",
                    }}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
