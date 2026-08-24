"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MessageAuthor } from "@prisma/client";
import type { TicketView } from "@/lib/tickets";
import { STATUS_LABEL, TICKET_LIMITS, categoryLabel } from "@/lib/support";

const POLL_MS = 4000;

/**
 * The support conversation — the same component on both sides.
 *
 *   viewer="user"  on /app/support/[id] (and /app/support/new with no ticket
 *                  yet: the first message starts one and the page moves to
 *                  its address).
 *   viewer="admin" inside the admin Tickets section.
 *
 * Three voices: the user, Grindly's assistant, and a person on the team. The
 * assistant answers inline (the send returns with its reply); "Talk to a
 * person" hands over. Polls every few seconds while open, so a reply from
 * the other side appears without a refresh — user and operator can genuinely
 * talk in near real time without a socket to keep alive.
 */
export function TicketThread({
  initial,
  viewer,
  backHref,
  backLabel,
}: {
  initial: TicketView | null;
  viewer: "user" | "admin";
  backHref: string;
  backLabel: string;
}) {
  const router = useRouter();
  const [ticket, setTicket] = useState<TicketView | null>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(initial?.messages.length ?? 0);

  // The id is the only thing polling depends on; holding it apart from the
  // ticket object keeps the callback stable across every poll's setTicket.
  const ticketId = ticket?.id ?? null;
  const refresh = useCallback(async () => {
    if (!ticketId) return;
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ticket) setTicket(data.ticket as TicketView);
    } catch {
      /* next tick */
    }
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, ticketId]);

  // Scroll to the newest message only when one ARRIVES — not on every poll,
  // which would yank the page out from under someone reading an older one.
  useEffect(() => {
    const n = ticket?.messages.length ?? 0;
    if (n > lastCount.current || thinking) {
      endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    lastCount.current = n;
  }, [ticket?.messages.length, thinking]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const willThink = viewer === "user" && (!ticket || ticket.handledBy === "assistant") && ticket?.status !== "closed";
    if (willThink) setThinking(true);
    try {
      const res = ticket
        ? await fetch(`/api/tickets/${ticket.id}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: body }),
          })
        : await fetch("/api/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: body }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not send that.");
        return;
      }
      setDraft("");
      setTicket(data.ticket as TicketView);
      if (!ticket && data.ticket?.id) {
        // The conversation now has an address; the list page will show it.
        router.replace(`/app/support/${data.ticket.id}`);
      }
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
      setThinking(false);
    }
  }

  async function askHuman() {
    if (!ticket || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/human`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not hand this to a person just now.");
        return;
      }
      if (data?.ticket) setTicket(data.ticket as TicketView);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!ticket || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/close`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not close this conversation.");
        return;
      }
      await refresh();
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const closed = ticket?.status === "closed";
  const withAssistant = !!ticket && ticket.handledBy === "assistant";

  function who(author: MessageAuthor): string {
    if (author === "assistant") return "Grindly assistant";
    if (author === "admin") return viewer === "admin" ? "You" : "Grindly team";
    return viewer === "user" ? "You" : "User";
  }
  function mine(author: MessageAuthor): boolean {
    return viewer === "user" ? author === "user" : author === "admin";
  }

  return (
    <div>
      <a href={backHref} className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm">
        ← {backLabel}
      </a>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold break-words">
            {ticket ? ticket.subject : "New conversation"}
          </h1>
          <p className="text-muted mt-1 font-mono text-[10px] tracking-[0.1em] uppercase">
            {ticket
              ? `${categoryLabel(ticket.category)} · started ${new Date(ticket.createdAt).toLocaleString()}${
                  viewer === "admin" ? ` · ${ticket.user.email}` : ""
                }`
              : "Grindly's assistant answers first; a person steps in when it matters"}
          </p>
        </div>
        {ticket && (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] uppercase"
              style={{ background: "var(--surface-2)", color: "var(--muted)" }}
            >
              {closed ? "closed" : withAssistant ? "with the assistant" : "with the team"}
            </span>
            <span
              className="rounded-full px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] uppercase"
              style={{ background: "var(--surface-2)", color: closed ? "var(--muted)" : "var(--brand)" }}
            >
              {STATUS_LABEL[ticket.status]}
            </span>
          </div>
        )}
      </div>

      {viewer === "admin" && ticket && (
        <div
          className="mt-4 rounded-xl border p-4 text-sm leading-relaxed"
          style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        >
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Assistant&rsquo;s summary</p>
          <p className="mt-1">{ticket.summary || "No summary yet — the assistant has not answered."}</p>
          {withAssistant && !closed && (
            <p className="text-muted mt-2 text-xs">
              The assistant is handling this. Replying takes it over — the assistant goes quiet and the user
              is emailed that a person answered.
            </p>
          )}
        </div>
      )}

      <ol className="mt-6 flex flex-col gap-3" aria-live="polite">
        {!ticket && (
          <li className="flex justify-start">
            <div
              className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[70%]"
              style={{ background: "var(--surface-2)", color: "var(--ink-color)" }}
            >
              <p>
                Hi — tell me what is going on in your own words. Something that failed, a score that
                surprised you, a payment, anything. If it is beyond me I will hand you to a person on the
                team, and you can ask for one at any point.
              </p>
              <p className="mt-1 font-mono text-[10px] tracking-[0.08em] uppercase opacity-70">Grindly assistant</p>
            </div>
          </li>
        )}
        {ticket?.messages.map((m) => {
          const own = mine(m.authorRole);
          return (
            <li key={m.id} className={`flex ${own ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[70%]"
                style={
                  own
                    ? { background: "var(--cta)", color: "var(--on-cta)" }
                    : m.authorRole === "assistant"
                      ? { background: "var(--surface-2)", color: "var(--ink-color)" }
                      : { background: "var(--surface)", color: "var(--ink-color)", border: "1px solid var(--border)" }
                }
              >
                <p>{m.body}</p>
                <p className="mt-1 font-mono text-[10px] tracking-[0.08em] uppercase opacity-70">
                  {who(m.authorRole)} · {new Date(m.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          );
        })}
        {thinking && (
          <li className="flex justify-start" aria-label="Assistant is typing">
            <div
              className="rounded-2xl px-4 py-2.5 text-sm"
              style={{ background: "var(--surface-2)", color: "var(--muted)" }}
            >
              <span className="typing-dots" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="sr-only">Assistant is typing</span>
            </div>
          </li>
        )}
        <div ref={endRef} />
      </ol>

      {closed && (
        <div
          className="mt-6 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        >
          This conversation is closed.{" "}
          {viewer === "user"
            ? "If it is not actually solved, just write below — that reopens it."
            : "A message from the user reopens it."}
        </div>
      )}

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
          placeholder={viewer === "admin" ? "Reply as a person on the team…" : "Write here…"}
          className="field w-full text-sm"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
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
          {viewer === "user" && ticket && withAssistant && !closed && (
            <button type="button" onClick={askHuman} disabled={busy} className="btn text-sm">
              Talk to a person
            </button>
          )}
          {ticket && !closed && (
            <button type="button" onClick={close} disabled={busy} className="btn text-sm">
              {viewer === "admin" ? "Close conversation" : "Mark solved"}
            </button>
          )}
          <span className="text-muted text-xs">Ctrl/⌘ + Enter sends.</span>
        </div>
      </form>
    </div>
  );
}
