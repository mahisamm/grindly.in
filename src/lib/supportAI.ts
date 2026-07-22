// AI support assistant — produces the reply the user sees PLUS the structured
// triage (subject/category/severity/summary) the admin queue shows. One Groq
// call, using the same provider/key/model the agent already runs in prod
// (agent/llm.py). It is deliberately BEST-EFFORT: any failure (no key, timeout,
// non-JSON, provider down) returns null so the caller still saves the ticket
// with a canned reply — a support message must never be lost to a model hiccup.

import { llmConfigured } from "@/lib/serverConfig";

export type SupportRole = "user" | "assistant";
export type SupportMsg = { role: SupportRole; content: string; at: string };

export const SUPPORT_CATEGORIES = ["bug", "account", "billing", "how_to", "feedback", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const SUPPORT_SEVERITIES = ["low", "normal", "high"] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];

export type SupportAI = {
  reply: string;
  subject: string;
  category: SupportCategory;
  severity: SupportSeverity;
  summary: string;
};

// Canned reply used when the model is unavailable. The ticket is still filed and
// a human still sees it — this just keeps the chat from going silent.
export const SUPPORT_FALLBACK_REPLY =
  "Thanks — I've logged this and someone on the team will follow up by email. " +
  "If it helps, add any extra detail (what you expected, a screenshot) and we'll get on it.";

// Product knowledge the assistant answers from — kept in step with /help so the
// bot deflects the common issues instead of filing a ticket for every one.
const KB = `Grindly is an AI agent that finds internships matching a student's resume, scores each 0-100 for fit, and PREPARES the application for the user to submit themselves in their own browser (Safe Apply Mode) — it never auto-submits and never sees platform passwords. Free plan: 5 prepared applications per day. Users connect job platforms (LinkedIn, Internshala, Naukri, Unstop, Indeed) by logging in themselves in a secure window. Daily reports arrive by email or Slack. Pause the agent anytime from the account menu. Delete the account and all data from Profile > Danger zone (permanent). Pay-to-apply "internships" that demand a fee from the student are auto-filtered. Common fixes: a "login required" flag means that platform's session expired — reconnect it in Integrations; zero matches usually means the minimum match score is too high or the domains/locations too narrow; a failed resume upload should be a PDF, DOCX, or TXT (paste the text if the PDF is a scan).`;

const SYSTEM = `You are Grindly's in-app support assistant, talking to a signed-in student. Be warm, concise, and practical. Use ONLY the product facts provided — never invent features, prices, or promises, and never ask for a password or OTP. If the facts clearly solve the issue, walk the user through it. If it needs a human (a bug, a billing or account problem, or anything the facts don't cover), reassure them a teammate will follow up.

Reply with a SINGLE JSON object and nothing else, in exactly this shape:
{"reply": string, "subject": string, "category": one of ["bug","account","billing","how_to","feedback","other"], "severity": one of ["low","normal","high"], "summary": string}
- "reply": your message to the user (plain text, no markdown headings).
- "subject": a title of at most 70 characters for the support queue.
- "category": the best fit for the user's issue.
- "severity": "high" only if the user is blocked or losing money; "low" for a question or feedback; otherwise "normal".
- "summary": one or two sentences for the admin, in the third person ("User can't connect Internshala...").`;

function clamp(s: unknown, max: number, fallback = ""): string {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

// Pull a JSON object out of the model's text even if it wrapped it in prose or
// ```json fences. Returns null if nothing parses.
function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Exported for unit testing — validate/coerce a raw model string into SupportAI,
// or null if it has no usable reply.
export function parseSupportAI(raw: string): SupportAI | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const reply = clamp(obj.reply, 1500);
  if (!reply) return null; // a response with no user-facing reply is useless
  const category = (SUPPORT_CATEGORIES as readonly string[]).includes(obj.category as string)
    ? (obj.category as SupportCategory)
    : "other";
  const severity = (SUPPORT_SEVERITIES as readonly string[]).includes(obj.severity as string)
    ? (obj.severity as SupportSeverity)
    : "normal";
  return {
    reply,
    subject: clamp(obj.subject, 70, "Support request"),
    category,
    severity,
    summary: clamp(obj.summary, 400, reply.slice(0, 200)),
  };
}

/**
 * Produce a reply + triage for the latest user turn. `history` is the full
 * conversation so far (already including the newest user message). Returns null
 * on ANY failure so the caller falls back to a canned reply + raw storage.
 */
export async function supportAssist(userContext: string, history: SupportMsg[]): Promise<SupportAI | null> {
  const key = process.env.GROQ_API_KEY;
  if (!llmConfigured() || !key || history.length === 0) return null;

  // Cap what we send: the last 16 turns is plenty of context and bounds cost.
  const turns = history.slice(-16).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const messages = [
    { role: "system", content: `${SYSTEM}\n\nProduct facts:\n${KB}\n\nUser context: ${userContext}` },
    ...turns,
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        max_tokens: 600,
        messages,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? parseSupportAI(content) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
