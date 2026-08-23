"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TicketCategory, TicketStatus } from "@prisma/client";
import { SUPPORT_CATEGORIES, STATUS_LABEL, TICKET_LIMITS, categoryLabel } from "@/lib/support";

export type TicketRow = {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  lastMessageAt: string;
  unread: boolean;
};

export function SupportDesk({ tickets }: { tickets: TicketRow[] }) {
  const router = useRouter();
  const [raising, setRaising] = useState(tickets.length === 0);
  const [category, setCategory] = useState<TicketCategory | "">("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picked = SUPPORT_CATEGORIES.find((c) => c.key === category);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, subject, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not open the ticket.");
        return;
      }
      router.push(`/app/support/${data.id}`);
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 flex flex-col gap-10">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold">Your tickets</h2>
          {!raising && (
            <button onClick={() => setRaising(true)} className="btn btn-primary text-sm">
              Raise a ticket
            </button>
          )}
        </div>
        {tickets.length === 0 ? (
          <p className="text-muted mt-3 text-sm">No tickets yet.</p>
        ) : (
          <ul className="border-border mt-3 divide-y rounded-xl border" style={{ borderColor: "var(--border)" }}>
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
                      {categoryLabel(t.category)} · {new Date(t.lastMessageAt).toLocaleDateString()}
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
      </section>

      {raising && (
        <section className="bg-surface border-border rounded-2xl border p-5 sm:p-6">
          <h2 className="font-display text-xl font-semibold">Raise a ticket</h2>
          <p className="text-muted mt-1 text-sm leading-relaxed">
            Pick what it is about. The quick fixes for that kind of problem show first — if one
            of them is your answer, you are done; if not, the box is right below.
          </p>

          <form onSubmit={submit} className="mt-5">
            <fieldset>
              <legend className="text-sm font-medium">What is it about?</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SUPPORT_CATEGORIES.map((c) => (
                  <label
                    key={c.key}
                    className="border-border flex cursor-pointer items-start gap-3 rounded-xl border p-3"
                    style={{
                      borderColor: category === c.key ? "var(--cta)" : "var(--border)",
                      background: category === c.key ? "var(--surface-2)" : "transparent",
                    }}
                  >
                    <input
                      type="radio"
                      name="category"
                      value={c.key}
                      checked={category === c.key}
                      onChange={() => setCategory(c.key)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium">{c.label}</span>
                      <span className="text-muted block text-xs leading-snug">{c.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {picked && picked.selfHelp.length > 0 && (
              <div
                className="mt-5 rounded-xl border p-4 text-sm leading-relaxed"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
              >
                <p className="font-medium">Before you write — the usual fixes</p>
                <ul className="mt-2 list-disc space-y-1.5 pl-5">
                  {picked.selfHelp.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <p className="text-muted mt-2 text-xs">Still stuck? Tell us below.</p>
              </div>
            )}

            {picked && (
              <>
                <label htmlFor="ticket-subject" className="mt-5 block text-sm font-medium">
                  Subject
                </label>
                <input
                  id="ticket-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={TICKET_LIMITS.subject}
                  placeholder="One line — what is wrong"
                  className="field mt-1.5 w-full text-sm"
                />
                <label htmlFor="ticket-message" className="mt-4 block text-sm font-medium">
                  What happened
                </label>
                <textarea
                  id="ticket-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  maxLength={TICKET_LIMITS.message}
                  placeholder={picked.prompt}
                  className="field mt-1.5 w-full text-sm"
                />
                {error && (
                  <p role="alert" className="mt-2 text-sm" style={{ color: "#a3271b" }}>
                    {error}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={busy || subject.trim().length < 4 || message.trim().length < 10}
                    className="btn btn-primary text-sm"
                  >
                    {busy ? "Opening…" : "Open the ticket"}
                  </button>
                  {tickets.length > 0 && (
                    <button type="button" onClick={() => setRaising(false)} className="btn text-sm">
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
