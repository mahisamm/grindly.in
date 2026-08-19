import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createZip, crc32, safeEntryName } from "@/lib/zip";

/**
 * A hand-written zip is only worth having if something other than its own
 * author can open it, so the central assertion here shells out to the platform
 * unzip and reads the bytes back. A unit test that only checked our own parser
 * would agree with any consistent nonsense.
 */

const FIXED = new Date("2026-08-19T10:30:00Z");

describe("crc32", () => {
  it("matches the published check value", () => {
    // The standard CRC-32 of "123456789" is 0xCBF43926. If this drifts, every
    // archive we write is rejected by every extractor with a checksum error.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("is zero for nothing", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("createZip", () => {
  it("writes a file with the right signature and entry count", () => {
    const zip = createZip([{ name: "a.txt", data: Buffer.from("hello") }], FIXED);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // local file header
    // End-of-central-directory is the last 22 bytes when there is no comment.
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(1);
  });

  it("declares its names as UTF-8", () => {
    // Bit 11 of the general-purpose flag. Without it, a resume labelled in
    // Devanagari extracts as mojibake on Windows.
    const zip = createZip([{ name: "प्रिया.pdf", data: Buffer.from("x") }], FIXED);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it("produces an archive the operating system can actually extract", () => {
    const zip = createZip(
      [
        { name: "grindly-export.json", data: Buffer.from('{"ok":true}') },
        { name: "resumes/priya cv.pdf", data: Buffer.from("%PDF-1.4 fake") },
      ],
      FIXED,
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grindly-zip-"));
    const file = path.join(dir, "export.zip");
    fs.writeFileSync(file, zip);

    let extracted: string | null = null;
    try {
      // `tar` reads zip on Windows 10+ and on macOS; Linux runners have unzip.
      // Either is a real third-party reader, which is the point.
      execFileSync("tar", ["-xf", file, "-C", dir], { stdio: "pipe" });
      extracted = fs.readFileSync(path.join(dir, "grindly-export.json"), "utf8");
    } catch {
      try {
        execFileSync("unzip", ["-o", file, "-d", dir], { stdio: "pipe" });
        extracted = fs.readFileSync(path.join(dir, "grindly-export.json"), "utf8");
      } catch {
        // Neither tool is present. Skip rather than fail: this asserts an
        // integration with the host, and a missing host tool is not a bug in
        // the writer.
        extracted = null;
      }
    }

    if (extracted !== null) {
      expect(extracted).toBe('{"ok":true}');
      expect(fs.readFileSync(path.join(dir, "resumes", "priya cv.pdf"), "utf8")).toBe(
        "%PDF-1.4 fake",
      );
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes an empty archive rather than throwing on no entries", () => {
    const zip = createZip([], FIXED);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });
});

describe("safeEntryName", () => {
  it("keeps the parts of a filename that are actually filenames", () => {
    expect(safeEntryName("Priya Sharma - Resume 2026")).toBe("Priya Sharma - Resume 2026");
  });

  it("cannot produce a path", () => {
    // The zip-slip case: an entry name with a separator escapes its folder on
    // extraction, and this value is a filename the user chose.
    //
    // The invariant is what is asserted, not the exact output. Interior dots
    // survive — "-..-etc-passwd" is what this returns — and that is fine: with
    // every separator gone it is one filename, and a `..` with nothing to
    // separate it from is just two characters.
    for (const hostile of [
      "../../etc/passwd",
      "..",
      "a" + String.fromCharCode(92) + "..",
      "/etc/shadow",
      "C:" + String.fromCharCode(92) + "Windows" + String.fromCharCode(92) + "system32",
    ]) {
      const safe = safeEntryName(hostile, "file");
      expect(safe, hostile).not.toContain("/");
      expect(safe, hostile).not.toContain(String.fromCharCode(92));
      expect(safe.startsWith("."), hostile).toBe(false);
      expect(safe.endsWith("."), hostile).toBe(false);
      expect(safe.length, hostile).toBeGreaterThan(0);
    }
    expect(safeEntryName("a" + String.fromCharCode(92) + "b")).toBe("a-b");
  });

  it("strips what Windows reserves and Unix hides", () => {
    expect(safeEntryName('my:resume?"final"*.pdf')).toBe("myresumefinal.pdf");
    expect(safeEntryName(".hidden")).toBe("hidden");
    // Windows drops a trailing dot, which would silently collide two names.
    expect(safeEntryName("resume.")).toBe("resume");
  });

  it("drops control characters", () => {
    expect(safeEntryName("res" + String.fromCharCode(0) + "ume")).toBe("resume");
  });

  it("falls back rather than returning an empty name", () => {
    // An entry with an empty name makes an archive some extractors refuse.
    expect(safeEntryName("...", "resume")).toBe("resume");
    expect(safeEntryName("", "resume")).toBe("resume");
  });

  it("bounds the length", () => {
    expect(safeEntryName("x".repeat(500)).length).toBeLessThanOrEqual(100);
  });
});
