"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STATUS_LABELS } from "../[id]/Progress";

type ResumeOption = { id: string; label: string; variantLabels: string[] };

type Row = {
  id: string;
  company: string;
  role: string;
  status: string;
  variantLabel: string | null;
  notes: string | null;
  appliedAt: string;
  resumeId: string;
  resumeLabel: string;
};

/**
 * The account-wide send tracker.
 *
 * Same three endpoints the per-resume version used — POST /api/applications
 * (which already requires a resumeId and checks ownership), PATCH and DELETE
 * /api/applications/[id]. The only additions here are a resume picker on the
 * log form and a Resume column on the table, because the list is no longer
 * scoped to one document.
 */
export function ApplicationsClient({
  resumes,
  applications,
}: {
  resumes: ResumeOption[];
  applications: Row[];
}) {
  const router = useRouter();
  const [resumeId, setResumeId] = useState(resumes[0]?.id ?? "");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [variantLabel, setVariantLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variantLabels = useMemo(
    () => resumes.find((r) => r.id === resumeId)?.variantLabels ?? [],
    [resumes, resumeId],
  );

  const replies = applications.filter((a) =>
    ["screening", "interview", "offer"].includes(a.status),
  ).length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim() || !resumeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeId, company, role, variantLabel }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not save that.");
        return;
      }
      setCompany("");
      setRole("");
      setVariantLabel("");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  // Refreshed only on success. The select is controlled by the row's stored
  // status, so a failed change snaps back either way — the difference is that
  // it now says why, instead of looking like the click did not register.
  async function update(id: string, status: string) {
    setError(null);
    try {
      const res = await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not change that status.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/applications/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not remove that.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    }
  }

  if (resumes.length === 0) {
    return (
      <div className="bg-surface border-border mt-8 rounded-xl border p-6 text-sm">
        <p className="text-muted">
          You have no resumes yet. Add one first, then log where you send it.
        </p>
        <Link href="/app/resumes" className="btn btn-primary mt-4">
          Add a resume
        </Link>
      </div>
    );
  }

  return (
    <section className="mt-8">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1.5 block text-sm font-medium">Resume</span>
          <select
            value={resumeId}
            onChange={(e) => {
              setResumeId(e.target.value);
              setVariantLabel("");
            }}
            className="field w-full"
          >
            {resumes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1.5 block text-sm font-medium">Company</span>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={120}
            className="field w-full"
            placeholder="Freshworks"
          />
        </label>
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1.5 block text-sm font-medium">Role</span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            maxLength={120}
            className="field w-full"
            placeholder="Backend Engineer"
          />
        </label>
        {variantLabels.length > 0 && (
          <label className="min-w-[10rem]">
            <span className="mb-1.5 block text-sm font-medium">Which version</span>
            <select
              value={variantLabel}
              onChange={(e) => setVariantLabel(e.target.value)}
              className="field w-full"
            >
              <option value="">Original</option>
              {variantLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          disabled={busy || !company.trim() || !resumeId}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : "Log it"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}

      {applications.length > 0 ? (
        <>
          <p className="text-muted mt-6 text-sm">
            {applications.length} logged · {replies} moved past &ldquo;sent&rdquo;
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  {["Company", "Role", "Resume", "Version", "Sent", "Status", ""].map((h) => (
                    <th
                      key={h}
                      className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase"
                    >
                      {h || " "}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id} className="border-border border-b">
                    <td className="py-2 pr-4">{a.company}</td>
                    <td className="text-muted py-2 pr-4">{a.role || "—"}</td>
                    <td className="text-muted py-2 pr-4">{a.resumeLabel}</td>
                    <td className="text-muted py-2 pr-4">{a.variantLabel || "Original"}</td>
                    <td className="text-muted py-2 pr-4 whitespace-nowrap">
                      {new Date(a.appliedAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}
                    </td>
                    <td className="py-2 pr-4">
                      <label className="sr-only" htmlFor={`status-${a.id}`}>
                        Status for {a.company}
                      </label>
                      <select
                        id={`status-${a.id}`}
                        value={a.status}
                        onChange={(e) => void update(a.id, e.target.value)}
                        className="field py-1 text-xs"
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() => void remove(a.id)}
                        aria-label={`Remove the application to ${a.company}`}
                        className="text-muted hover:text-ink cursor-pointer text-xs"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-muted mt-6 text-sm">
          Nothing logged yet. Add the first company above.
        </p>
      )}
    </section>
  );
}
