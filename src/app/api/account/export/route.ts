import { NextResponse } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireUser, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { RESUME_DIR, VARIANT_DIR } from "@/lib/agent";
import { createZip, safeEntryName, type ZipEntry } from "@/lib/zip";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading every PDF a heavy user has produced off a spinning disk on a small
// box takes longer than a default budget allows.
export const maxDuration = 120;

/**
 * Everything we hold about you, in one file.
 *
 * The privacy policy claims portability, and DPDP 2023 s.11 and GDPR art.20
 * grant it. Until now the only way to exercise it was to open every resume and
 * download each PDF by hand, and there was no way at all to get the scores,
 * the findings or the record of what was measured — the part that is arguably
 * the product.
 *
 * The archive contains:
 *
 *   grindly-export.json   every row, with the reports and fidelity counts
 *   resumes/              the original files, as uploaded
 *   variants/             every rebuilt PDF, named by resume and strategy
 *
 * What it does not contain is anything about anyone else, and nothing derived
 * from another account. The one judgement call is the password hash, which is
 * excluded: it is not data about the user in any sense they can use, and a
 * scrypt hash in a file in a downloads folder is a liability handed to them.
 */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // An export reads the whole account off disk. Cheap for one person, and a way
  // to pin a one-vCPU box if requested in a loop.
  if (await isRateLimited(`export:acct:${user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "You can export a few times an hour. Try again shortly." },
      { status: 429 },
    );
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true, email: true, name: true, plan: true, planExpiresAt: true,
      role: true, timezone: true, emailVerifiedAt: true, createdAt: true,
      resumes: {
        orderBy: { createdAt: "asc" },
        include: {
          variants: { orderBy: { createdAt: "asc" } },
          targets: { orderBy: { createdAt: "asc" } },
          scores: { orderBy: { createdAt: "asc" } },
        },
      },
      orders: { orderBy: { createdAt: "asc" } },
      auditLogs: { orderBy: { createdAt: "asc" }, take: 2000 },
      usage: { orderBy: { localDate: "asc" } },
    },
  });
  if (!account) return serverError("Account not found.", `account/export:${user.id}`);

  const entries: ZipEntry[] = [];
  // Names must be unique inside the archive: two resumes both called
  // "resume.pdf" would otherwise produce a zip where one silently replaces the
  // other on extraction. The row id is the disambiguator, and it is also what
  // ties a file back to its entry in the JSON.
  const fileIndex: Array<{ resumeId: string; kind: string; path: string; label: string }> = [];

  for (const resume of account.resumes) {
    const stem = safeEntryName(resume.label, "resume");

    if (resume.ext) {
      const source = path.join(RESUME_DIR, `${resume.id}${resume.ext}`);
      const bytes = await fsp.readFile(source).catch(() => null);
      // A missing file is not an error worth failing the export for: the row
      // still describes what was measured, and an export that refuses because
      // one byte-blob went missing gives the user nothing at all.
      if (bytes) {
        const name = `resumes/${stem}-${resume.id.slice(-6)}${resume.ext}`;
        entries.push({ name, data: bytes });
        fileIndex.push({ resumeId: resume.id, kind: "original", path: name, label: resume.label });
      }
    }

    for (const variant of resume.variants) {
      // `file` is "<runId>/variant-N.pdf". It round-trips through the database,
      // so it is untrusted on the way back out — each segment is sanitised and
      // the resolved path is checked to be inside the root, the same way the
      // download route does it. A traversal here would put arbitrary server
      // files into a user's export.
      const segments = variant.file.split("/").map((seg) => path.basename(seg));
      const source = path.join(VARIANT_DIR, resume.id, ...segments);
      const root = path.resolve(VARIANT_DIR);
      if (!path.resolve(source).startsWith(root + path.sep)) continue;

      const bytes = await fsp.readFile(source).catch(() => null);
      if (!bytes) continue;
      const name = `variants/${stem}-${safeEntryName(variant.label, "variant")}-${variant.id.slice(-6)}.pdf`;
      entries.push({ name, data: bytes });
      fileIndex.push({
        resumeId: resume.id,
        kind: `variant:${variant.label}`,
        path: name,
        label: variant.label,
      });
    }
  }

  const manifest = {
    exported_at: new Date().toISOString(),
    what_this_is:
      "Everything Grindly holds about this account. Reports and scores are the " +
      "output of agent/readiness.py, which is a pure function of the resume text — " +
      "the same bytes give the same number on any machine.",
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      plan: account.plan,
      plan_expires_at: account.planExpiresAt,
      role: account.role,
      timezone: account.timezone,
      email_verified_at: account.emailVerifiedAt,
      created_at: account.createdAt,
    },
    resumes: account.resumes,
    orders: account.orders,
    daily_usage: account.usage,
    activity: account.auditLogs,
    files: fileIndex,
    not_included: [
      "The password hash. It is not usable data and it is not worth having in a downloads folder.",
      "Anything about any other account.",
    ],
  };

  entries.unshift({
    name: "grindly-export.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });

  let archive: Buffer;
  try {
    archive = createZip(entries);
  } catch (e) {
    return serverError("Could not build the export.", `account/export: ${String(e)}`);
  }

  await audit(user.id, "account_export", `${entries.length} files`);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="grindly-export-${stamp}.zip"`,
      "Content-Length": String(archive.length),
      // Never cached, anywhere. This is one file containing an entire person.
      "Cache-Control": "no-store, private",
    },
  });
}
