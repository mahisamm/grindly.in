"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string; at?: string };

// Opening line — shown locally before the user says anything. Not persisted
// until they send their first message (which creates the ticket server-side).
const GREETING: Msg = {
  role: "assistant",
  content:
    "Hi! I'm Grindly's assistant. Tell me what's going wrong or what you'd like help with — " +
    "I'll try to sort it right here, and it's logged for the team to read.",
};

export default function SupportChat({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Resume an existing open ticket, if any.
  useEffect(() => {
    let alive = true;
    fetch("/api/support")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const existing = d?.ticket?.messages;
        if (Array.isArray(existing) && existing.length) setMessages(existing);
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Keep the latest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError("");
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setSending(true);
    try {
      const r = await fetch("/api/support/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (r.status === 429) {
        setError("You're sending messages quickly — give it a minute.");
      } else if (!r.ok) {
        throw new Error("failed");
      } else {
        const d = await r.json();
        setMessages((m) => [...m, { role: "assistant", content: d.reply }]);
      }
    } catch {
      setError("Couldn't send that. Please try again.");
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Sorry — something went wrong sending that. Please try again, or email support if it keeps happening." },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Grindly support chat"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-[0_10px_60px_rgba(23,20,15,0.3)] sm:h-[70vh] sm:rounded-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full brand-gradient text-sm text-white">✦</span>
            <div>
              <p className="text-sm font-semibold text-foreground">Grindly support</p>
              <p className="text-xs text-muted">Replies here · logged for the team</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close support"
            className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "rounded-br-sm bg-brand text-white"
                    : "rounded-bl-sm bg-surface-2 text-foreground"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm bg-surface-2 px-3.5 py-3 text-sm text-muted">
                <span className="inline-flex gap-1">
                  <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.3s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.15s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted" />
                </span>
              </div>
            </div>
          )}
        </div>

        {/* input */}
        <div className="border-t border-border p-3">
          {error && <p className="mb-2 px-1 text-xs text-danger">{error}</p>}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              autoFocus
              placeholder="Describe your issue…"
              className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none focus:border-brand"
            />
            <button
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              className="press shrink-0 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-muted">
            {loaded ? "Enter to send · Shift+Enter for a new line" : "Loading your conversation…"}
          </p>
        </div>
      </div>
    </div>
  );
}
