"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Role, TicketCategory, TicketStatus } from "@prisma/client";
import { STATUS_LABEL, TICKET_LIMITS, categoryLabel } from "@/lib/support";

export type ThreadView = {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  lastMessageAt: string;
  lastMessageBy: Role;
  closedAt: string | null;
  user: { id: string; email: string; name: string | null };
  messages: { id: string; authorRole: Role; body: string; createdAt: string }[];
};

const POLL_MS = 4000;

/**
 * The conversation. Used on both sides — the user's /app/support/[id] and the
 * admin's ticket panel — with `viewer` deciding which bubbles are "you".
 *
 * Polls every few seconds while open so a reply from the other side appears
 * without a refresh; this is the same lightweight pattern the rebuild banner
 * uses, and it means a user and the operator can genuinely talk in near real
 * time without a socket to keep alive.
 */
export function TicketThread({
  initial,
  viewer,
  backHref,
  backLabel,
}: {
  initial: ThreadView;
  viewer: Role;
  backHref: string;
  backLabel: string;
}) {
  const router = useRouter();
  const [ticket, setTicket] = useState<ThreadView>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(initial.messages.length);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/tickets/${initial.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ticket) setTicket(data.ticket as ThreadView);
    } catch {
      /* next tick */
    }
  }, [initial.id]);

  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Scroll to the newest message only when one ARRIVES — not on every poll,
  // which would yank the page out from under someone reading an older one.
  useEffect(() => {
    if (ticket.messages.length > lastCount.current) {
      endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    lastCount.current = ticket.messages.length;
  }, [ticket.messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${initial.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not send that.");
        return;
      }
      setTicket(data.ticket as ThreadView);
      setDraft("");
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    try {
      const res = await fetch(`/api/tickets/${initial.id}/close`, { method: "POST" });
      if (res.ok) {
        await refresh();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const closed = ticket.status === "closed";
  const you = viewer;

  return (
    <div>
      <a href={backHref} className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm">
        ← {backLabel}
      </a>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold break-words">{ticket.subject}</h1>
          <p className="text-muted mt-1 font-mono text-[10px] tracking-[0.1em] uppercase">
            {categoryLabel(ticket.category)} · opened {new Date(ticket.createdAt).toLocaleString()}
            {viewer === "admin" ? ` · ${ticket.user.email}` : ""}
          </p>
        </div>
        <span
          className="rounded-full px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] uppercase"
          style={{ background: "var(--surface-2)", color: closed ? "var(--muted)" : "var(--brand)" }}
        >
          {STATUS_LABEL[ticket.status]}
        </span>
      </div>

      <ol className="mt-6 flex flex-col gap-3" aria-live="polite">
        {ticket.messages.map((m) => {
          const mine = m.authorRole === you;
          return (
            <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[70%]"
                style={
                  mine
                    ? { background: "var(--cta)", color: "var(--on-cta)" }
                    : { background: "var(--surface-2)", color: "var(--ink-color)" }
                }
              >
                <p>{m.body}</p>
                <p
                  className="mt-1 font-mono text-[10px] tracking-[0.08em] uppercase opacity-70"
                >
                  {m.authorRole === "admin"
                    ? viewer === "admin" ? "You" : "Grindly support"
                    : viewer === "admin" ? "User" : "You"}{" "}
                  · {new Date(m.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          );
        })}
        <div ref={endRef} />
      </ol>

      {closed ? (
        <div
          className="mt-6 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        >
          This ticket is closed.{" "}
          {viewer === "user"
            ? "If it is not actually solved, just reply below — that reopens it."
            : "A reply from the user reopens it."}
        </div>
      ) : null}

      <form onSubmit={send} className="mt-4">
        <label htmlFor="ticket-reply" className="sr-only">
          Your message
        </label>
        <textarea
          id="ticket-reply"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={TICKET_LIMITS.message}
          placeholder={viewer === "admin" ? "Reply to the user…" : "Write a reply…"}
          className="field w-full text-sm"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send(e);
          }}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm" style={{ color: "#a3271b" }}>
            {error}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || !draft.trim()} className="btn btn-primary text-sm">
            {busy ? "Sending…" : "Send"}
          </button>
          {!closed && (
            <button type="button" onClick={close} disabled={busy} className="btn text-sm">
              {viewer === "admin" ? "Close ticket" : "Mark solved"}
            </button>
          )}
          <span className="text-muted text-xs">Ctrl/⌘ + Enter sends.</span>
        </div>
      </form>
    </div>
  );
}
