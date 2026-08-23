import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/auth";
import { loadTicket, markSeen, actorOf } from "@/lib/tickets";
import { STATUS_LABEL, categoryLabel } from "@/lib/support";
import { TicketThread } from "@/components/TicketThread";
import { Section, StatGrid, Stat } from "./Panels";

const FILTERS: { key: string; label: string; hint: string; where: Prisma.TicketWhereInput }[] = [
  {
    key: "queue",
    label: "Needs a person",
    hint: "Handed over to the team and the ball is with you — the user or the assistant spoke last.",
    where: { status: { not: "closed" }, handledBy: "human", lastMessageBy: { not: "admin" } },
  },
  {
    key: "human",
    label: "With the team",
    hint: "Every open conversation a person is handling.",
    where: { status: { not: "closed" }, handledBy: "human" },
  },
  {
    key: "assistant",
    label: "With the assistant",
    hint: "Open conversations the assistant is still handling — read, do not reply, unless you want to take over.",
    where: { status: { not: "closed" }, handledBy: "assistant" },
  },
  { key: "closed", label: "Closed", hint: "Marked solved by either side.", where: { status: "closed" } },
  { key: "all", label: "All", hint: "Everything.", where: {} },
];

/**
 * The operator's support desk. The assistant has usually already talked to
 * the user; what you read here first is its SUMMARY, not the thread. `?t=<id>`
 * opens one conversation in place with the same chat component the user
 * sees. Opening it marks it read; replying takes it over from the assistant.
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
        <Section title="Conversation" note="">
          <p className="text-muted mt-3 text-sm">
            No such conversation.{" "}
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
        <TicketThread initial={ticket} viewer="admin" backHref="/admin?s=tickets" backLabel="All conversations" />
      </div>
    );
  }

  const filter = FILTERS.find((f) => f.key === status) ?? FILTERS[0];
  const [rows, queue, withTeam, withAssistant, closed] = await Promise.all([
    prisma.ticket.findMany({
      where: filter.where,
      orderBy: { lastMessageAt: "desc" },
      take: 100,
      select: {
        id: true, category: true, subject: true, status: true, handledBy: true, summary: true,
        lastMessageAt: true, lastMessageBy: true, adminSeenAt: true, createdAt: true,
        user: { select: { email: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.ticket.count({ where: FILTERS[0].where }),
    prisma.ticket.count({ where: FILTERS[1].where }),
    prisma.ticket.count({ where: FILTERS[2].where }),
    prisma.ticket.count({ where: FILTERS[3].where }),
  ]);

  return (
    <Section
      title="Tickets"
      note="Every conversation starts with Grindly's assistant, which answers from the product notes and writes you a running summary. It hands over when money, data, an unresolved bug, or a request for a person comes up — those land in 'Needs a person'. Your reply takes a conversation over for good and emails the user; their reply reopens it."
    >
      <StatGrid>
        <Stat label="Needs a person" value={queue} tone={queue > 0 ? "warn" : undefined} sub="handed over, ball with you" />
        <Stat label="With the team" value={withTeam} sub="open, human-handled" />
        <Stat label="With the assistant" value={withAssistant} sub="open, assistant-handled" />
        <Stat label="Closed" value={closed} />
      </StatGrid>

      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter conversations">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/admin?s=tickets&status=${f.key}`}
            aria-current={filter.key === f.key ? "page" : undefined}
            title={f.hint}
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
      <p className="text-muted mt-2 text-xs">{filter.hint}</p>

      {rows.length === 0 ? (
        <p className="text-muted mt-4 text-sm">Nothing here.</p>
      ) : (
        <ul className="mt-3 divide-y rounded-xl border" style={{ borderColor: "var(--border)" }}>
          {rows.map((t) => {
            const unread =
              t.handledBy === "human" &&
              t.lastMessageBy !== "admin" &&
              (!t.adminSeenAt || t.adminSeenAt < t.lastMessageAt);
            return (
              <li key={t.id}>
                <Link
                  href={`/admin?s=tickets&t=${t.id}`}
                  className="hover:bg-surface-2 block px-4 py-3"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {unread && (
                        <span
                          aria-label="Unread"
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: "var(--vermilion)" }}
                        />
                      )}
                      <span className={`truncate ${unread ? "font-semibold" : ""}`}>{t.subject}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
                        style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                      >
                        {t.status === "closed" ? "closed" : t.handledBy === "assistant" ? "assistant" : "team"}
                      </span>
                      <span
                        className="rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
                        style={{
                          background: "var(--surface-2)",
                          color: t.status === "closed" ? "var(--muted)" : "var(--brand)",
                        }}
                      >
                        {STATUS_LABEL[t.status]}
                      </span>
                    </span>
                  </span>
                  <span className="text-muted mt-1 block text-sm leading-snug">
                    {t.summary || "No summary yet."}
                  </span>
                  <span className="text-muted mt-1 block font-mono text-[10px] tracking-[0.1em] uppercase">
                    {t.user.email} · {categoryLabel(t.category)} · {t._count.messages} msg ·{" "}
                    {t.lastMessageAt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
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
