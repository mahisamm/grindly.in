import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateExtension } from "@/lib/extensionAuth";
import { computeReadiness } from "@/lib/readiness";
import { browserExecutorEnabled } from "@/lib/serverConfig";

/**
 * POST /api/extension/plan — what to type into the form the extension is looking at.
 *
 * The extension is the HANDS. It runs in the student's own browser, where a
 * CAPTCHA has a person to answer it and the IP is residential — which is the
 * only reason Keka, Internshala and the stricter Greenhouse tenants are
 * reachable at all. From our servers those checks are asking "is a human here?"
 * and the honest answer is no.
 *
 * The BRAIN stays here. The extension's own decision logic is four regexes
 * (phone, email, CGPA, name), it cannot read a `<select>` at all, and it knows
 * nothing about gender, school, degree, years of experience, notice period or
 * expected stipend — most of which agent/questions.py learned the hard way,
 * against real forms that stopped mid-application. Reimplementing that in
 * JavaScript would mean rediscovering every one of those bugs a second time.
 *
 * So this route authenticates the browser (the one thing only the web app can
 * do), loads the facts the user actually gave us, and forwards the snapshot to
 * the planner service, which runs the same engine the server-side sender uses.
 *
 * What it will never return: an answer nobody gave us. A field the engine
 * cannot answer honestly comes back in `unanswered`, and the extension shows
 * that to the user instead of typing a guess under their name.
 */
export const dynamic = "force-dynamic";

// A form snapshot, bounded. Anything past this is a page that has gone wrong,
// and forwarding it would just move the problem to the planner.
const MAX_FIELDS = 300;

export async function POST(req: Request) {
  const auth = await authenticateExtension(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Same fleet switch the claim endpoint honours. An operator turning the
  // executor off must stop work immediately, without every extension updating.
  if (!browserExecutorEnabled()) {
    return NextResponse.json({ error: "executor_disabled" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    fields?: unknown;
    job?: { title?: string; company?: string };
    coverLetter?: string;
  };
  const fields = Array.isArray(body.fields) ? body.fields.slice(0, MAX_FIELDS) : [];
  if (!fields.length) {
    return NextResponse.json({ fills: [], unanswered: [], considered: 0 });
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    // The whole answer bank, not the subset the claim endpoint sends. Every
    // omission here is a form the agent stops on for a fact the user already
    // gave us — which is exactly how gender, sitting unread in the profile,
    // blocked every Keka application.
    select: { name: true, email: true, profile: true },
  });
  if (!user?.profile) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Re-checked here rather than trusted from when the task was queued: consent
  // can be revoked in between, and the check closest to the typing is the only
  // one that protects anybody.
  const readiness = computeReadiness(user);
  if (!readiness.ready) {
    return NextResponse.json(
      { error: "not_ready", missing: readiness.missing },
      { status: 409 },
    );
  }

  const p = user.profile;
  // snake_case because the engine reads the Python column names, and this is
  // the seam between the two naming worlds. Keeping the mapping explicit — one
  // line per fact — is what makes a missing one visible in review rather than
  // discovered when an application stops on it.
  const profile: Record<string, unknown> = {
    phone: p.phone ?? "",
    gpa: p.gpa ?? "",
    degree: p.degree ?? "",
    college: p.college ?? "",
    education: p.education ?? "",
    grad_year: p.gradYear ?? "",
    grad_month: p.gradMonth ?? "",
    education_start_year: p.educationStartYear ?? "",
    class10_percent: p.class10Percent ?? "",
    class12_percent: p.class12Percent ?? "",
    gender: p.gender ?? "",
    date_of_birth: p.dateOfBirth ?? "",
    differently_abled: p.differentlyAbled ?? "",
    nationality: p.nationality ?? "",
    country: p.country ?? "",
    years_experience: p.yearsExperience ?? "",
    current_salary: p.currentSalary ?? "",
    expected_stipend: p.expectedStipend ?? "",
    previous_internship: p.previousInternship ?? "",
    notice_period: p.noticePeriod ?? "",
    current_location: p.currentLocation ?? "",
    preferred_locations: p.preferredLocations ?? "[]",
    preferred_domains: p.preferredDomains ?? "[]",
    needs_sponsorship: p.needsSponsorship ?? "",
    work_authorization: p.workAuthorization ?? "",
    willing_to_relocate: p.willingToRelocate ?? "",
    availability: p.availability ?? "",
    hours_per_week: p.hoursPerWeek ?? "",
    linkedin_url: p.linkedinUrl ?? "",
    github_url: p.githubUrl ?? "",
    portfolio_url: p.portfolioUrl ?? "",
  };

  const plannerUrl = process.env.GRINDLY_PLANNER_URL || "http://planner:8781";
  const secret = process.env.GRINDLY_PLANNER_SECRET || "";
  if (!secret) {
    // Fail closed and say so. Answering with an empty plan would look like
    // "this form has nothing we can fill", which is a different and much more
    // confusing problem to debug.
    return NextResponse.json({ error: "planner_not_configured" }, { status: 503 });
  }

  try {
    const res = await fetch(`${plannerUrl}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Planner-Secret": secret },
      body: JSON.stringify({
        fields,
        profile,
        name: user.name ?? "",
        email: user.email ?? "",
        resumeText: p.resumeText ?? "",
        skills: p.skills ?? "[]",
        job: body.job ?? {},
        coverLetter: body.coverLetter ?? "",
      }),
      // The browser is holding a real application open while this runs.
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "planner_error" }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "planner_unreachable" }, { status: 502 });
  }
}
