/**
 * The support desk's vocabulary — shared by the user's "Raise a ticket" form,
 * the admin ticket list and the notification emails, so a category means the
 * same thing on every side.
 *
 * Each category carries its SELF-HELP first: the two or three things that
 * resolve the common version of that problem without a ticket at all. They
 * are shown before the text box, not after it — a person who finds their
 * answer there has been helped faster than any reply could manage, and the
 * tickets that do get raised are the ones that genuinely need a human.
 */
import type { TicketCategory, TicketStatus } from "@prisma/client";

export type SupportCategory = {
  key: TicketCategory;
  label: string;
  /** One line under the label in the picker. */
  hint: string;
  /** Plain-words self-help, shown once the category is picked. */
  selfHelp: string[];
  /** Placeholder for the message box — a prompt for the details that let
      the operator answer in one reply instead of three. */
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
  answered: "Answered — your turn",
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
