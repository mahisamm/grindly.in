"use client";

import Link from "next/link";
import type { HandledBy, TicketCategory, TicketStatus } from "@prisma/client";
import { STATUS_LABEL, categoryLabel } from "@/lib/support";

export type TicketRow = {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  handledBy: HandledBy;
  createdAt: string;
  lastMessageAt: string;
  unread: boolean;
};

/** The user's conversations, and the door to a new one. */
export function SupportDesk({ tickets }: { tickets: TicketRow[] }) {
  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">Your conversations</h2>
        <Link href="/app/support/new" className="btn btn-primary text-sm">
          New conversation
        </Link>
      </div>
      {tickets.length === 0 ? (
        <p className="text-muted mt-3 text-sm">
          Nothing yet. Start one — the assistant answers straight away, and a person steps in
          when it matters.
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-xl border" style={{ borderColor: "var(--border)" }}>
          {tickets.map((t) => (
            <li key={t.id}>
              <Link
                href={`/app/support/${t.id}`}
                className="hover:bg-surface-2 flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    {t.unread && (
                      <span
                        aria-label="New reply"
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: "var(--vermilion)" }}
                      />
                    )}
                    <span className={`truncate ${t.unread ? "font-semibold" : ""}`}>{t.subject}</span>
                  </span>
                  <span className="text-muted mt-0.5 block font-mono text-[10px] tracking-[0.1em] uppercase">
                    {categoryLabel(t.category)} · {t.handledBy === "assistant" ? "with the assistant" : "with the team"} ·{" "}
                    {new Date(t.lastMessageAt).toLocaleDateString()}
                  </span>
                </span>
                <span
                  className="rounded-full px-2.5 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
                  style={{
                    background: "var(--surface-2)",
                    color: t.status === "answered" ? "var(--brand)" : "var(--muted)",
                  }}
                >
                  {STATUS_LABEL[t.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
