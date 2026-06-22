"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/Brand";
import { humanFailure } from "@/lib/applyState";

type ResumeVersion = {
  id: string;
  label: string;
  skillsClaimed: string;
  baseSkills: string;
  filePath: string | null;
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

function chips(json: string): string[] {
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

export default function ApplicationsPage() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/applications")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((j) => setApps(j.applications))
      .catch(() => setErr("Couldn't load applications. Are you logged in?"));
  }, []);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-5 py-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="display text-4xl sm:text-5xl">Your applications</h1>
            <p className="mt-2 text-muted">
              Every application the agent sent — with the exact resume a recruiter saw.
              Open one before an interview call to see what you presented.
            </p>
          </div>
          <Link href="/dashboard" className="rounded-xl border-2 border-ink bg-surface px-4 py-2 font-semibold transition hover:bg-surface-2">
            ← Dashboard
          </Link>
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
                      {a.status.replace("_", " ")}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t-2 border-dashed border-border px-5 py-4 text-sm">
                    {a.reason && <p className="text-muted">{a.reason}</p>}
                    {a.failureReason && (
                      <p className="mt-1 text-danger">⚠ {humanFailure(a.failureReason)}</p>
                    )}

                    {a.resumeVersion ? (
                      <div className="mt-4 rounded-xl border-2 border-border bg-surface-2 p-4">
                        <div className="font-display font-semibold">Resume sent</div>
                        <div className="text-xs text-muted">{a.resumeVersion.label}</div>

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
      </main>
    </>
  );
}
