#!/usr/bin/env node
/**
 * The running application, exercised end to end.
 *
 * This file exists because of two bugs that shipped past a green test suite.
 * The beta access queue rendered its Approve buttons off the right edge of a
 * phone screen, and the "already decided" list showed the oldest accounts on
 * the site rather than the most recent decisions. 249 unit tests and 401 agent
 * tests passed through both, because neither one is reachable from a pure
 * function: one is a browser laying out a real page, the other is an ORDER BY.
 *
 * So this runs against a SERVER THAT IS UP, over HTTP, with real rows. It signs
 * up, gets gated, gets approved, promotes a rebuild, downloads it, gets blocked,
 * exports its data and deletes itself — and checks the state the database is
 * actually left in at each step, not what the response said.
 *
 * Usage:
 *   npm run build && npm start        # in one terminal
 *   npm run smoke                     # in another
 *
 * BASE_URL overrides the target. It refuses to touch a database that is not
 * local unless SMOKE_ALLOW_REMOTE=1 is set, because it creates and deletes
 * accounts and the failure mode of pointing it at production is not one you can
 * undo.
 */
import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const prisma = new PrismaClient();

const results = [];
let failed = 0;
function check(name, condition, detail = "") {
  if (!condition) failed++;
  results.push({ ok: Boolean(condition), name, detail: String(detail) });
}

/** Refuse to run destructively against anything that is not a dev database. */
function guard() {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  if (!local && process.env.SMOKE_ALLOW_REMOTE !== "1") {
    console.error(
      "smoke: DATABASE_URL does not look local, and this script creates and\n" +
        "deletes accounts. Set SMOKE_ALLOW_REMOTE=1 only if you are certain.",
    );
    process.exit(2);
  }
}

/** One session's worth of fetch: keeps whatever cookie the server last set. */
function session() {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    async call(url, init = {}) {
      const res = await fetch(BASE + url, {
        ...init,
        redirect: "manual",
        headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return res;
    },
  };
}

async function main() {
  guard();

  // Is anything even listening? A connection refused here reads as forty
  // failures otherwise, none of which mean anything.
  try {
    await fetch(BASE + "/", { redirect: "manual" });
  } catch {
    console.error(`smoke: nothing is answering on ${BASE}. Start the server first.`);
    process.exit(2);
  }

  const stamp = Date.now();
  const user = session();
  const admin = session();
  const userEmail = `smoke-user-${stamp}@example.invalid`;
  const adminEmail = `smoke-admin-${stamp}@example.invalid`;
  const password = "a-long-enough-password";
  let userRow = null;
  let adminRow = null;
  let resumeId = null;

  try {
    // ---- the operator, created FIRST and deliberately so -----------------
    //
    // api/auth/signup promotes the very first account on a fresh database to
    // admin, so that a new deployment has a way to reach its own admin surface.
    // Signing the user up first therefore makes the user an admin on an empty
    // database, which silently turns off every gate this script exists to test:
    // the run reported seven failures the first time it met a freshly migrated
    // database, none of them a defect in the product.
    let res = await admin.call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password, name: "Operator" }),
    });
    adminRow = await prisma.user.findUnique({ where: { email: adminEmail } });
    await prisma.user.update({
      where: { id: adminRow.id },
      data: { role: "admin", accessStatus: "approved" },
    });

    // ---- the beta door ---------------------------------------------------
    res = await user.call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password, name: "Priya Ramanathan" }),
    });
    check("signup succeeds", res.status === 200, `status ${res.status}`);
    userRow = await prisma.user.findUnique({ where: { email: userEmail } });
    check("a new account starts pending", userRow?.accessStatus === "pending", userRow?.accessStatus);
    check("a new account is not an admin", userRow?.role === "user", userRow?.role);

    res = await user.call("/app");
    check(
      "a pending account is sent to /pending",
      res.status === 307 && (res.headers.get("location") ?? "").endsWith("/pending"),
      `${res.status} → ${res.headers.get("location")}`,
    );
    check("/pending itself renders", (await user.call("/pending")).status === 200);

    res = await user.call("/api/resumes/nope/primary", { method: "POST" });
    check("a gated API refuses a pending account", res.status === 403, `status ${res.status}`);

    // Deliberately open to pending accounts: the person the gate misfired on is
    // exactly who needs to reach the operator.
    res = await user.call("/api/problems", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "I cannot get in and I have an interview.", path: "/pending" }),
    });
    check("a pending account can still report a problem", res.status === 200, `status ${res.status}`);

    res = await user.call(`/api/admin/access/${userRow.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    check("a normal account cannot work the queue", res.status !== 200, `status ${res.status}`);

    res = await admin.call(`/api/admin/access/${adminRow.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    check("the queue refuses to act on an admin", res.status === 404, `status ${res.status}`);

    res = await admin.call(`/api/admin/access/${userRow.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    check("the operator can approve", res.status === 200, `status ${res.status}`);
    let after = await prisma.user.findUnique({ where: { id: userRow.id } });
    check(
      "approval records who and when",
      after.accessStatus === "approved" && after.approvedBy === adminRow.id && !!after.approvedAt,
    );
    check("/admin renders for an admin", (await admin.call("/admin")).status === 200);

    // ---- a rebuild, and promoting it ------------------------------------
    const source = await prisma.resume.create({
      data: {
        userId: userRow.id,
        label: "My resume",
        text: "Priya Ramanathan\nBackend Engineer",
        chars: 34,
        score: 71,
        grade: "C",
      },
    });
    resumeId = source.id;
    const target = await prisma.target.create({
      data: { userId: userRow.id, resumeId: source.id, kind: "company", name: "Zoho", specJson: {} },
    });
    const dir = path.join(process.cwd(), "data", "variants", source.id, "smoke");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "variant-1.pdf"), "%PDF-1.4 smoke\n");
    const variant = await prisma.variant.create({
      data: {
        resumeId: source.id,
        targetId: target.id,
        label: "Impact-focused",
        score: 88,
        grade: "A",
        baselineScore: 71,
        beatsBaseline: true,
        pages: 1,
        structJson: {
          name: "Priya Ramanathan",
          contact_line: "priya@example.com",
          sections: [
            { heading: "EXPERIENCE", items: [{ head: "Backend Engineer", sub: "Zoho | Chennai", bullets: ["Cut p99 to 380ms."] }] },
          ],
        },
        text: "Priya Ramanathan\nBackend Engineer\nZoho · Chennai\nCut p99 to 380ms.",
        file: "smoke/variant-1.pdf",
        bytes: 15,
      },
    });

    res = await user.call(`/api/variants/${variant.id}/file?download=1`);
    let cd = res.headers.get("content-disposition") ?? "";
    check(
      "a download is named for the company and the person",
      cd.includes('filename="Zoho-Priya-Ramanathan-Resume.pdf"'),
      cd,
    );
    check("a download never carries the strategy label", !/impact/i.test(cd), cd);
    cd = (await user.call(`/api/variants/${variant.id}/file`)).headers.get("content-disposition") ?? "";
    check("opening one is still inline", cd.startsWith("inline"), cd);

    res = await user.call(`/api/variants/${variant.id}/promote`, { method: "POST" });
    const promoted = await res.json().catch(() => ({}));
    check("promote succeeds", res.status === 200, `status ${res.status}`);
    const owned = await prisma.resume.findMany({ where: { userId: userRow.id }, orderBy: { createdAt: "asc" } });
    check("promote creates rather than overwrites", owned.length === 2, `${owned.length} resumes`);
    check("the original keeps its own score", owned[0].score === 71, String(owned[0].score));
    const child = owned.find((r) => r.id === promoted.id);
    check("the promoted copy carries the rebuild's score", child?.score === 88, String(child?.score));
    check("the promoted copy carries the employer", child?.targetName === "Zoho", child?.targetName);
    check(
      "the promoted copy records its provenance",
      child?.fromVariantId === variant.id && child?.parentResumeId === source.id,
    );
    after = await prisma.user.findUnique({ where: { id: userRow.id } });
    check("promote moves the primary pointer", after.primaryResumeId === promoted.id);

    cd =
      (await user.call(`/api/resumes/${promoted.id}/export?format=txt`)).headers.get(
        "content-disposition",
      ) ?? "";
    check("a promoted export follows the same naming", cd.includes('filename="Zoho-Priya-Ramanathan-Resume.txt"'), cd);

    res = await user.call(`/api/resumes/${source.id}/primary`, { method: "POST" });
    after = await prisma.user.findUnique({ where: { id: userRow.id } });
    check("primary swaps back", res.status === 200 && after.primaryResumeId === source.id);
    check("swapping back deletes nothing", (await prisma.resume.count({ where: { userId: userRow.id } })) === 2);

    const listing = await (await user.call("/app")).text();
    check("the resume list marks the primary", listing.includes("Sending this one"));
    check("the resume list offers the swap", listing.includes("Send this one instead"));

    // ---- blocking, and what survives it ---------------------------------
    await admin.call(`/api/admin/access/${userRow.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    res = await user.call("/app");
    check(
      "blocking takes effect on the very next request",
      res.status === 307 && (res.headers.get("location") ?? "").endsWith("/pending"),
      `status ${res.status}`,
    );
    check("/pending says suspended, not 'nearly there'", (await (await user.call("/pending")).text()).includes("cannot use Grindly"));
    check("a blocked account can still take its data", (await user.call("/api/account/export")).status === 200);

    // ---- delete means delete --------------------------------------------
    // ---- does anything fall off the side of a phone ----------------------
    //
    // Run from HERE, while the admin session and its rows still exist, because
    // the page the layout bug was actually on is one you have to be signed in
    // to see. Python rather than Node: Playwright is already installed for the
    // agent's PDF renderer, and a second browser download to lay out seven
    // pages is not a trade worth making.
    const layout = spawnSync(
      process.env.PYTHON_BIN || "python",
      ["scripts/browser_check.py", BASE, "--cookie", admin.cookie],
      { encoding: "utf8" },
    );
    if (layout.error) {
      console.log("  note  layout sweep skipped —", layout.error.message);
    } else {
      process.stdout.write(layout.stdout ?? "");
      check("no layout or accessibility failures in a real browser", layout.status === 0,
            (layout.stderr || "").trim().slice(0, 200));
    }

    check("the problem report was stored", (await prisma.problemReport.count({ where: { userId: userRow.id } })) === 1);
    await prisma.user.delete({ where: { id: userRow.id } });
    check(
      "deleting the account deletes the problem report",
      (await prisma.problemReport.count({ where: { userId: userRow.id } })) === 0,
    );
    check("deleting the account deletes the resumes", (await prisma.resume.count({ where: { userId: userRow.id } })) === 0);
    userRow = null;
  } finally {
    // Fixtures go even when an assertion threw, or the next run inherits them.
    if (userRow) await prisma.user.delete({ where: { id: userRow.id } }).catch(() => {});
    if (adminRow) await prisma.user.delete({ where: { id: adminRow.id } }).catch(() => {});
    if (resumeId) {
      await fs
        .rm(path.join(process.cwd(), "data", "variants", resumeId), { recursive: true, force: true })
        .catch(() => {});
    }
    await prisma.$disconnect();
  }

  for (const r of results) {
    console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke: crashed —", e);
  process.exit(1);
});
