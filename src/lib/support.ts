/**
 * The support desk's vocabulary — what the ASSISTANT knows about the product
 * (lib/tickets.ts feeds the self-help below into its prompt), how the admin
 * list labels a conversation, and what the notification emails say. The user
 * never sees a picker: they just write, and the assistant sorts it.
 *
 * Each category carries its SELF-HELP: the two or three things that resolve
 * the common version of that problem. The assistant says them in its own
 * words; keeping them here, not in the prompt, means one edit updates what
 * it knows.
 */
import type { TicketCategory, TicketStatus } from "@prisma/client";

export type SupportCategory = {
  key: TicketCategory;
  label: string;
  /** One line describing the category, for the admin list. */
  hint: string;
  /** Plain-words self-help — the assistant's knowledge for this category. */
  selfHelp: string[];
  /** The details that let a person answer in one reply — the assistant asks
      for these when it hands over. */
  prompt: string;
};

export const SUPPORT_CATEGORIES: SupportCategory[] = [
  {
    key: "rebuild",
    label: "A rebuild or tailored resume",
    hint: "It failed, produced nothing, or the result looks wrong.",
    selfHelp: [
      "A run that ends with \"could not produce\" was not charged — press Rebuild once more; most of these pass on the second try.",
      "If a tailored resume scores below your original, that is expected: it is reshaped for the company. The card shows both numbers.",
      "Open the PDF and check it reads right. If something in it is not on your resume, tell us below — that should never happen.",
    ],
    prompt: "Which resume and which company? What did you expect, and what did you get? Paste the message you saw, if any.",
  },
  {
    key: "upload",
    label: "Uploading or reading my resume",
    hint: "The file was refused, or the score seems wrong for it.",
    selfHelp: [
      "PDF, DOCX or TXT up to 5 MB. A scanned or image-only PDF has no text a parser can read — export it from the editor you wrote it in.",
      "The score measures what a machine recovers from the file, not how good the resume is. Open \"What the machine reads\" to see exactly what was read.",
    ],
    prompt: "What file type and roughly how big? What did the page say? If the score surprised you, what did you expect?",
  },
  {
    key: "billing",
    label: "Payment, plan or unlock",
    hint: "Charged but nothing changed, a refund, or a plan question.",
    selfHelp: [
      "Paid but the company is still locked? Refresh once — the unlock arrives a few seconds after the payment confirms.",
      "Every charge is listed under Account settings → Plan. Refunds are described at /refunds.",
    ],
    prompt: "The email you paid with, roughly when, and the amount. If you have a payment id from Razorpay, include it.",
  },
  {
    key: "account",
    label: "Signing in, email or my account",
    hint: "Can't sign in, verification mail missing, want something changed.",
    selfHelp: [
      "No verification or reset email? Check spam, then request it again from the sign-in page — each link is valid for a limited time.",
      "Signed up with Google? Use \"Continue with Google\"; there is no password to reset.",
    ],
    prompt: "The email on the account and what happens when you try. Never send us your password.",
  },
  {
    key: "bug",
    label: "Something looks broken",
    hint: "A page errors, a button does nothing, a layout is off.",
    selfHelp: [
      "Hard-refresh once (Ctrl/Cmd + Shift + R). If it persists, tell us the page and what you pressed.",
    ],
    prompt: "Which page (the address helps), what you did, what happened, and your browser if you know it.",
  },
  {
    key: "feature",
    label: "An idea or a request",
    hint: "Something you wish it did.",
    selfHelp: [
      "Short and concrete beats long: what were you trying to do when you missed it?",
    ],
    prompt: "What would it do, and when would you use it?",
  },
  {
    key: "other",
    label: "Something else",
    hint: "None of the above fits.",
    selfHelp: [],
    prompt: "Tell us what is going on, in your own words.",
  },
];

export function categoryLabel(key: TicketCategory): string {
  return SUPPORT_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  answered: "Answered",
  closed: "Closed",
};

export const TICKET_LIMITS = {
  subject: 120,
  message: 4000,
  /** New tickets per account per hour. */
  perHour: 5,
  /** Messages per account per hour. */
  messagesPerHour: 40,
} as const;

/**
 * The one address people can write to. Shown on /contact, /refunds and the
 * Contact & feedback dialog — change it HERE only.
 *
 * Today it is the operator's personal Gmail. The intended value is
 * support@grindly.in forwarding to that Gmail (a forwarder at the DNS host,
 * not a new mailbox) — flip this line once the forwarder is live.
 */
export const SUPPORT_EMAIL = "mahendharsammeta21@gmail.com";
