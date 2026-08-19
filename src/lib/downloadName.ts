/**
 * What a downloaded resume is called.
 *
 * This is not cosmetic. The file leaves here and arrives in somebody else's
 * inbox under whatever name we gave it, sits in a folder with two hundred
 * others, and gets opened — or not — on the strength of that name.
 *
 * Two rules, and the second one is the reason this file exists.
 *
 * THE COMPANY AND THE PERSON, in that order. "Zoho-Mahendhar-Sammeta.pdf"
 * sorts by employer in the sender's own downloads folder, which is where a
 * placement season turns into forty near-identical PDFs, and it identifies the
 * candidate in the recipient's.
 *
 * NEVER THE STRATEGY LABEL. Variants are called things like "Keyword-optimized"
 * and "ATS-clean", which are our words for how a rewrite was aimed, and the
 * download route used to put them in the filename: a resume left this product
 * as "my-resume-keyword-optimized.pdf" and was emailed to a recruiter under
 * that name. It tells the reader the document was machine-tuned for their
 * filter, which is both nobody's business and the worst possible framing of
 * something the candidate has every right to do. The label stays on the card,
 * where it is a description of a choice. It does not go in the filename, and it
 * does not go on the wire.
 */

/**
 * Letters, digits and combining marks in any script; everything else separates.
 *
 * `\p{M}` is not decoration. Devanagari writes a vowel as a mark attached to the
 * consonant before it, and those marks are Mn/Mc, not L — so a set of just
 * letters and digits treats every matra as a word boundary and "महेंद्र"
 * comes out as four fragments joined by hyphens. On a product whose users are
 * largely in India, a filename that shreds the candidate's own name is not an
 * edge case, and it fails silently: the file downloads, it just downloads
 * wrong.
 */
function words(value: string | null | undefined): string[] {
  return (value ?? "").split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
}

/**
 * The base name, without extension: "Zoho-Mahendhar-Sammeta-Resume".
 *
 * "Resume" is appended because a file called "Zoho-Mahendhar-Sammeta" in a
 * folder of attachments does not say what it is, and the one thing a recruiter
 * does with it is search for the word.
 */
export function resumeFileStem(person: string | null | undefined, company?: string | null): string {
  const parts = [...words(company).slice(0, 4), ...words(person).slice(0, 4)];
  if (!parts.length) return "Resume";
  // Capped rather than truncated mid-word: a name cut in half reads as a bug in
  // whatever produced it.
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    if (length + part.length + 1 > 70) break;
    kept.push(part);
    length += part.length + 1;
  }
  if (!kept.length) return "Resume";
  return [...kept, "Resume"].join("-");
}

/**
 * A `Content-Disposition` value that survives a name written in any script.
 *
 * Emits both forms RFC 6266 defines. `filename` is the ASCII fallback for
 * anything old enough not to understand the other one; `filename*` carries the
 * real name percent-encoded as UTF-8. A candidate whose resume says
 * "महेंद्र सम्मेता" gets their own name on the file in every current browser
 * and a readable "Resume.pdf" in the ones that predate the extension —
 * rather than the mojibake that a raw non-ASCII header produces, or the silent
 * truncation to nothing that stripping non-ASCII would.
 */
export function contentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  // Quotes and backslashes would terminate the quoted-string early; control
  // characters would split the header. Neither can reach here through a name
  // built by `resumeFileStem`, but this function is also the one place a future
  // caller might pass something straight through.
  const clean = filename.replace(/["\\]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "") || "Resume";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
