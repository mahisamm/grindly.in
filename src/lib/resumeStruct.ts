/**
 * The resume as editable fields.
 *
 * `{name, contact_line, sections[{heading, items[{head, sub, bullets[]}]}]}` —
 * the exact shape `render_pdf.build_html` prints and the exact shape the rewrite
 * pipeline works from. There is deliberately only one structure in this product:
 * a second one for the editor would be a translation layer between the thing the
 * user edits and the thing that gets rendered, and every divergence between them
 * would show up as a field that saves and then does not appear in the PDF.
 *
 * Validated on the way in from the browser AND on the way out of the database,
 * for different reasons. From the browser because it is untrusted. From the
 * database because it may have been written by the Python extractor months ago,
 * before some change to the shape, and a page that renders `undefined` where a
 * job title should be is worse than one that says it could not read this.
 */
import { z } from "zod";

export const ResumeItemSchema = z.object({
  /** The line that carries the identity: a job title, a degree, a project name. */
  head: z.string().default(""),
  /** Employer, institution, dates — whatever qualifies the head. */
  sub: z.string().default(""),
  bullets: z.array(z.string()).default([]),
});

export const ResumeSectionSchema = z.object({
  heading: z.string().default(""),
  items: z.array(ResumeItemSchema).default([]),
});

export const ResumeStructSchema = z.object({
  name: z.string().default(""),
  contact_line: z.string().default(""),
  sections: z.array(ResumeSectionSchema).default([]),
});

export type ResumeItem = z.infer<typeof ResumeItemSchema>;
export type ResumeSection = z.infer<typeof ResumeSectionSchema>;
export type ResumeStruct = z.infer<typeof ResumeStructSchema>;

/**
 * Caps, so one document cannot become an unbounded render.
 *
 * Chromium is rendering this on a one-vCPU box with 760 MB free while the rest
 * of the stack runs. These are generous against any real resume — the longest
 * academic CV anyone has uploaded had nine sections — and they exist for the
 * request that is not a resume.
 */
export const LIMITS = {
  sections: 20,
  itemsPerSection: 40,
  bulletsPerItem: 20,
  headChars: 200,
  bulletChars: 600,
  nameChars: 120,
  contactChars: 400,
} as const;

export function readStruct(value: unknown): ResumeStruct | null {
  if (value === null || value === undefined) return null;
  const parsed = ResumeStructSchema.safeParse(value);
  if (!parsed.success) {
    console.error("[resumeStruct] stored structure did not parse:", parsed.error.issues.slice(0, 3));
    return null;
  }
  return parsed.data;
}

/**
 * Take what the browser sent and make it something we are willing to print.
 *
 * Truncation rather than rejection, everywhere it can be. Someone who pastes a
 * 4 000-character paragraph into a bullet has made a formatting mistake, not an
 * attack, and answering that with a red error and a lost draft is a worse
 * product than a bullet that came back shorter than they typed it.
 *
 * Empty structures ARE rejected, because rendering one produces a blank PDF
 * that scores badly and looks like the tool is broken.
 */
export function sanitizeStruct(value: unknown): ResumeStruct | null {
  const parsed = ResumeStructSchema.safeParse(value);
  if (!parsed.success) return null;
  const struct = parsed.data;

  const clean: ResumeStruct = {
    name: struct.name.trim().slice(0, LIMITS.nameChars),
    contact_line: struct.contact_line.trim().slice(0, LIMITS.contactChars),
    sections: struct.sections.slice(0, LIMITS.sections).map((section) => ({
      heading: section.heading.trim().slice(0, LIMITS.headChars),
      items: section.items.slice(0, LIMITS.itemsPerSection).map((item) => ({
        head: item.head.trim().slice(0, LIMITS.headChars),
        sub: item.sub.trim().slice(0, LIMITS.headChars),
        bullets: item.bullets
          .slice(0, LIMITS.bulletsPerItem)
          .map((b) => b.trim().slice(0, LIMITS.bulletChars))
          // An empty bullet renders as a lone bullet glyph with nothing beside
          // it, which a parser reads as a fragment and a human reads as a
          // mistake.
          .filter(Boolean),
      })),
    })),
  };

  // A section with no items and no heading contributes nothing but whitespace.
  clean.sections = clean.sections.filter(
    (s) => s.heading || s.items.some((i) => i.head || i.sub || i.bullets.length),
  );

  const hasContent = clean.sections.some((s) =>
    s.items.some((i) => i.head || i.sub || i.bullets.length),
  );
  if (!hasContent) return null;

  return clean;
}

/**
 * Everything in the structure as one string, for the anti-fabrication check.
 *
 * The editor is the one path in this product where new facts legitimately
 * enter — it is the user typing about themselves, which is the only source this
 * product has ever accepted. So there are no gates here. This exists so the
 * saved text can be re-scored: the readiness score is computed from text, and
 * the text that matters after an edit is the edited one.
 */
export function structToText(struct: ResumeStruct): string {
  const lines: string[] = [];
  if (struct.name) lines.push(struct.name);
  if (struct.contact_line) lines.push(struct.contact_line);
  for (const section of struct.sections) {
    lines.push("", section.heading);
    for (const item of section.items) {
      if (item.head) lines.push(item.head);
      if (item.sub) lines.push(item.sub);
      for (const bullet of item.bullets) lines.push(`• ${bullet}`);
    }
  }
  return lines.join("\n");
}
