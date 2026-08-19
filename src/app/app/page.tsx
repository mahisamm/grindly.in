import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { formatLimit, isUnlimited, limitsFor } from "@/lib/plans";
import { pickPrimary } from "@/lib/primary";
import { Uploader } from "./Uploader";
import { MakePrimary } from "./MakePrimary";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your resumes — Grindly" };

export default async function WorkspacePage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const resumes = await prisma.resume.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, chars: true, score: true, grade: true,
      createdAt: true, parentResumeId: true,
      _count: { select: { variants: true, targets: true } },
    },
  });

  const limit = limitsFor(user).resumes;
  // Resolved rather than read straight off the account, because the stored id
  // outlives the row it names — there is no foreign key, on purpose. A pointer
  // at a deleted resume falls back to the newest one, which is what this page
  // treated as current before the concept existed.
  const primary = pickPrimary(resumes, user.primaryResumeId);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold sm:text-3xl">Your resumes</h1>
          <p className="text-muted mt-1.5 text-sm">
            {resumes.length === 0
              ? "Upload the PDF you have been sending to employers. In about a second you will see exactly what a parser reads off it — which is usually not what you think."
              : isUnlimited(limit)
                ? `${resumes.length} stored · no limit on this account.`
                : `${resumes.length} of ${formatLimit(limit)} used on your plan.`}
          </p>
        </div>
      </div>

      {/* One dashed box, not two.
          An empty account showed the drop zone and then a second, identical
          dashed panel headed "Nothing here yet" directly underneath it —
          telling someone there is nothing here, immediately below the control
          that exists because there is nothing here. The sentence that was worth
          keeping moved up under the heading. */}
      <div className="mt-6 sm:mt-8">
        <Uploader canUpload={resumes.length < limit} limit={limit} />
      </div>

      {resumes.length > 0 && (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 sm:mt-10 lg:grid-cols-3">
          {resumes.map((r) => (
            <li
              key={r.id}
              className="bg-surface border-border hover:border-ink flex h-full flex-col rounded-xl border transition-colors"
              // The one being sent gets a border, not a background. A filled
              // card in a grid of outlined ones reads as "selected, and about to
              // do something"; this is a state, not a selection.
              style={primary?.id === r.id ? { borderColor: "var(--cta)" } : undefined}
            >
              <Link href={`/app/${r.id}`} className="block flex-1 p-5">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-display text-lg leading-tight font-semibold">{r.label}</h2>
                  {r.score !== null && (
                    <span
                      className="shrink-0 rounded px-2 py-1 font-mono text-xs tabular-nums"
                      style={{
                        background:
                          r.score >= 70 ? "var(--brand)" : r.score >= 40 ? "#a8730f" : "#a3271b",
                        color: "var(--paper)",
                      }}
                    >
                      {r.score}
                    </span>
                  )}
                </div>
                <p className="text-muted mt-2 font-mono text-[11px] tracking-[0.08em] uppercase">
                  {r.chars.toLocaleString()} chars read
                  {r._count.variants > 0 && ` · ${r._count.variants} rewrites`}
                  {r._count.targets > 0 && ` · ${r._count.targets} targets`}
                </p>
                <p className="text-muted mt-3 text-xs">
                  {new Date(r.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric", month: "short", year: "numeric",
                  })}
                  {r.parentResumeId && " · rebuilt from another resume"}
                </p>
              </Link>
              <div className="border-border flex items-center justify-between gap-3 border-t px-5 py-3">
                {primary?.id === r.id ? (
                  <span
                    className="font-mono text-[11px] tracking-[0.08em] uppercase"
                    style={{ color: "var(--cta)" }}
                  >
                    Sending this one
                  </span>
                ) : (
                  <MakePrimary id={r.id} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
