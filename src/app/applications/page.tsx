"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Nav } from "@/components/Brand";
import { humanFailure } from "@/lib/applyState";

type ResumeVersion = {
  id: string;
  label: string;
  skillsClaimed: string;
  baseSkills: string;
  filePath: string | null;
  // false = your master resume went out untouched. The agent only rewrites when the
  // master genuinely under-sells you for that role — every edit is a chance to break
  // a layout your college mandated, so the default is to leave it alone.
  tailored: boolean;
  // 0-100: how well the master already covered this role. This is the number that
  // decided whether to edit.
  fitScore: number | null;
};

type Application = {
  id: string;
  jobTitle: string;
  company: string;
  url: string | null;
  matchScore: number;
  status: string;
  reason: string | null;
  failureReason: string | null;
  screenshotPath: string | null;
  appliedAt: string | null;
  createdAt: string;
  resumeVersion: ResumeVersion | null;
  outcome: string | null;
  // JSON [{q, a, source}] — the platform's screening questions and the answers
  // submitted under the user's name. See agent/questions.py.
  answersJson: string | null;
};

type Answer = { q: string; a: string; source: string };

function answers(json: string | null): Answer[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? (a as Answer[]) : [];
  } catch {
    return [];
  }
}

const ANSWER_SOURCE: Record<string, string> = {
  profile: "from your profile",
  ai: "written from your resume",
  fallback: "written from your skills",
  default: "picked from the options",
};

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-accent/15 text-accent border-accent",
  matched: "bg-brand/10 text-brand border-brand",
  approved: "bg-brand/10 text-brand border-brand",
  submitting: "bg-warn/15 text-warn border-warn",
  needs_review: "bg-warn/15 text-warn border-warn",
  skipped: "bg-surface-2 text-muted border-border",
  failed: "bg-danger/12 text-danger border-danger",
};

// Same vocabulary as the dashboard so a status never has two names across pages.
const STATUS_LABEL: Record<string, string> = {
  applied: "Applied",
  matched: "Ready",
  approved: "To submit",
  submitting: "Submitting",
  needs_review: "Needs review",
  skipped: "Skipped",
  failed: "Failed",
};

function chips(json: string): string[] {
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

const OUTCOME_LABELS: Record<string, string> = {
  interview:   "Got interview",
  offer:       "Got offer",
  rejected:    "Rejected",
  no_response: "No response",
};

export default function ApplicationsPage() {
  const router = useRouter();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  async function markOutcome(id: string, outcome: string | null) {
    setMarkingId(id);
    try {
      const r = await fetch("/api/applications/outcome", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, outcome }),
      });
      if (r.ok) {
        setOutcomes((prev) => {
          const next = { ...prev };
          if (outcome === null) delete next[id]; else next[id] = outcome;
          return next;
        });
        setApps((prev) => prev?.map((a) => a.id === id ? { ...a, outcome } : a) ?? prev);
      }
    } finally {
      setMarkingId(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    fetch(`/api/applications?${params}`)
      .then((r) => {
        if (r.status === 401) { router.replace("/login"); return Promise.reject(null); }
        return r.ok ? r.json() : Promise.reject(r);
      })
      .then((j) => {
        setApps(j.applications);
        setTotal(j.total ?? j.applications.length);
        setTotalPages(j.totalPages ?? 1);
      })
      .catch((e) => { if (e !== null) setErr("Couldn't load applications."); });
  }, [router, page, statusFilter]);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-5 py-12">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="display text-4xl sm:text-5xl">Your applications</h1>
            <p className="mt-2 text-muted">
              Every application the agent sent — with the exact resume a recruiter saw.
              Open one before an interview call to see what you presented.
            </p>
          </div>
          <Link href="/dashboard" className="self-start sm:self-auto rounded-xl border-2 border-ink bg-surface px-4 py-2 font-semibold transition hover:bg-surface-2">
            ← Dashboard
          </Link>
        </div>

        {/* Status filter buttons */}
      <div className="mt-6 flex flex-wrap gap-2">
        {/* "matched" reads as "ready" — the server only ever sends matches that have
            come due, so from here it means "waiting on your tap", not "somewhere in
            the pipeline". See src/lib/pipeline.ts. */}
        {([
          ["all", "All"],
          ["applied", "Applied"],
          ["matched", "Ready"],
          ["failed", "Failed"],
          ["skipped", "Skipped"],
        ] as const).map(([s, label]) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              statusFilter === s
                ? "border-brand bg-brand/10 text-brand"
                : "border-border text-muted hover:border-brand/50"
            }`}
          >
            {label}
          </button>
        ))}
        {total > 0 && (
          <span className="ml-auto text-xs text-muted self-center">{total} total</span>
        )}
      </div>

      {err && <p className="mt-8 text-danger">{err}</p>}
        {!apps && !err && <p className="mt-8 text-muted">Loading…</p>}
        {apps && apps.length === 0 && (
          <div className="sticker mt-8 rounded-3xl bg-surface p-8 text-center text-muted">
            No applications yet. Once the agent runs, they show up here.
          </div>
        )}

        <div className="mt-8 space-y-3">
          {apps?.map((a) => {
            const claimed = a.resumeVersion ? chips(a.resumeVersion.skillsClaimed) : [];
            const base = a.resumeVersion ? chips(a.resumeVersion.baseSkills) : [];
            const isOpen = open === a.id;
            return (
              <div key={a.id} className="sticker rounded-2xl bg-surface">
                <button
                  onClick={() => setOpen(isOpen ? null : a.id)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="truncate font-display text-lg font-semibold">{a.jobTitle}</div>
                    <div className="truncate text-sm text-muted">{a.company}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="font-mono font-semibold text-brand">{a.matchScore}</span>
                    <span
                      className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${
                        STATUS_STYLE[a.status] ?? "bg-surface-2 text-muted border-border"
                      }`}
                    >
                      {STATUS_LABEL[a.status] ?? a.status.replace("_", " ")}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t-2 border-dashed border-border px-5 py-4 text-sm">
                    {a.reason && <p className="text-muted">{a.reason}</p>}
                    {a.failureReason && (
                      <p className="mt-1 text-danger">⚠ {humanFailure(a.failureReason)}</p>
                    )}

                    {a.status === "applied" && (() => {
                      const current = outcomes[a.id] ?? a.outcome;
                      return (
                        <div className="mt-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">
                            What happened?
                          </p>
                          {current ? (
                            <div className="flex items-center gap-2">
                              <span className="rounded-md border border-accent bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                                {OUTCOME_LABELS[current] ?? current}
                              </span>
                              <button
                                onClick={() => markOutcome(a.id, null)}
                                className="text-xs text-muted hover:text-ink"
                              >
                                Clear
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {(["interview","offer","rejected","no_response"] as const).map((o) => (
                                <button
                                  key={o}
                                  disabled={markingId === a.id}
                                  onClick={() => markOutcome(a.id, o)}
                                  className="rounded-lg border-2 border-border bg-surface px-3 py-1 text-xs font-semibold transition hover:border-ink hover:bg-surface-2 disabled:opacity-50"
                                >
                                  {o === "interview" ? "Got interview 🎉"
                                    : o === "offer" ? "Got offer 🏆"
                                    : o === "rejected" ? "Rejected"
                                    : "No response"}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* What the platform asked, and what went out under your name.
                        Read this before an interview — you will be asked to defend
                        it, and it is the one thing you never got to see before. */}
                    {(() => {
                      const qa = answers(a.answersJson);
                      if (!qa.length) return null;
                      return (
                        <div className="mt-4 rounded-xl border-2 border-border bg-surface-2 p-4">
                          <div className="font-display font-semibold">
                            What you were asked
                          </div>
                          <p className="mt-0.5 text-xs text-muted">
                            Submitted in your name. Facts came from your profile; the rest
                            was written from your resume — nothing was invented.
                          </p>
                          <dl className="mt-3 space-y-3">
                            {qa.map((x, i) => (
                              <div key={i}>
                                <dt className="text-xs font-semibold text-muted">
                                  {x.q || "Question"}
                                </dt>
                                <dd className="mt-0.5 text-sm">
                                  {x.a}
                                  <span className="ml-2 whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
                                    {ANSWER_SOURCE[x.source] ?? x.source}
                                  </span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      );
                    })()}

                    {a.resumeVersion ? (
                      <div className="mt-4 rounded-xl border-2 border-border bg-surface-2 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-display font-semibold">Resume sent</span>
                          <span
                            className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${
                              a.resumeVersion.tailored
                                ? "border-brand bg-brand/10 text-brand"
                                : "border-border bg-surface text-muted"
                            }`}
                          >
                            {a.resumeVersion.tailored ? "Tailored ✎" : "Your master resume"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted">{a.resumeVersion.label}</div>

                        {/* Why this resume and not the other one. The agent leaves the
                            master alone unless it genuinely under-sells you here. */}
                        {a.resumeVersion.fitScore != null && (
                          <p className="mt-2 text-xs text-muted">
                            {a.resumeVersion.tailored ? (
                              <>
                                Your master resume only covered{" "}
                                <span className="text-foreground font-medium">
                                  {a.resumeVersion.fitScore}%
                                </span>{" "}
                                of what this role asked for, so the agent reordered your
                                Skills and Hobbies sections. Nothing else on the page was
                                touched, and no skill you don&apos;t have was added.
                              </>
                            ) : (
                              <>
                                Your master resume already covered{" "}
                                <span className="text-foreground font-medium">
                                  {a.resumeVersion.fitScore}%
                                </span>{" "}
                                of this role — it went out unchanged.
                              </>
                            )}
                          </p>
                        )}

                        <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">
                          What you presented for this role
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {claimed.length ? (
                            claimed.map((s) => (
                              <span key={s} className="rounded-md border border-ink bg-surface px-2 py-0.5 text-xs">
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted">No skills recorded.</span>
                          )}
                        </div>

                        <a
                          href={`/api/applications/${a.id}/resume`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-4 inline-block rounded-xl brand-gradient sticker-sm px-4 py-2 text-sm font-semibold"
                        >
                          Download exact resume sent ↗
                        </a>
                        {base.length > 0 && claimed.length < base.length && (
                          <p className="mt-3 text-xs text-muted">
                            Your master resume lists {base.length} skills; {claimed.length} were
                            surfaced for this role. Nothing outside your master set was added.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-muted">
                        No tailored-resume snapshot for this application (skipped/demo run).
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
                      {a.url && (
                        <a href={a.url} target="_blank" rel="noreferrer" className="brand-text font-medium">
                          View listing ↗
                        </a>
                      )}
                      {a.screenshotPath && (
                        <span>Proof screenshot captured</span>
                      )}
                      <span>Logged {new Date(a.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      
      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 pb-6">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:border-brand/50 transition disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-muted">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:border-brand/50 transition disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
      </main>
    </>
  );
}
