/**
 * A minimal ZIP writer — store only, no compression.
 *
 * Written here rather than pulled in, and both halves of that are deliberate.
 *
 * NO COMPRESSION: everything this archive carries is a PDF, and a PDF's content
 * streams are already deflated. Re-compressing them buys a percent or two for
 * the CPU cost of the whole export, on a box with one vCPU. The JSON alongside
 * them is a few kilobytes.
 *
 * NO DEPENDENCY: the store-only format is a header, a body and a directory
 * entry per file, and this is the whole of it. The alternative is a package
 * with its own transitive tree, in a project that just removed five unused
 * dependencies — a data-export feature is not worth re-growing node_modules
 * for eighty lines of byte layout.
 *
 * Limits, stated rather than discovered: this writes ZIP32 with no ZIP64
 * records, so it is correct up to 4 GB total and 65 535 entries. An export is a
 * handful of PDFs.
 *
 * Format reference: PKWARE APPNOTE 4.3 sections 4.3.7 (local header), 4.3.12
 * (central directory) and 4.3.16 (end of central directory).
 */

/** CRC-32, the one part of a store-only zip that is real work. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

/**
 * DOS date/time, which is what the format stores.
 *
 * Seconds have one bit less than they need (the field counts two-second
 * intervals) and the epoch is 1980. A date before that would encode as garbage,
 * so it is clamped rather than wrapped.
 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    // Bit 11: the name is UTF-8. Without it a resume labelled in Devanagari or
    // with an accented name unzips to mojibake on Windows.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // method 0: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42); // offset of local header

    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * Make a filename safe to write on any of the three desktop operating systems.
 *
 * A resume is labelled by its uploaded filename, which is whatever the user's
 * machine allowed — colons from macOS, slashes typed by hand, a trailing dot
 * that Windows silently drops. A path separator here would also let an entry
 * name escape its folder in the archive, which is the classic zip-slip.
 */
export function safeEntryName(name: string, fallback = "file"): string {
  // Written as a scan rather than a chain of regexes, because the character
  // classes involved — path separators, Windows-reserved punctuation, the C0
  // controls — are all backslash escapes, and an escape that is wrong here
  // fails silently: the name still looks fine in the common case and only
  // breaks on the resume with a colon in its filename. A comparison against a
  // code point cannot be mis-escaped.
  const SEPARATORS = ["/", String.fromCharCode(92)];
  const RESERVED = new Set(["<", ">", ":", String.fromCharCode(34), "|", "?", "*"]);

  let out = "";
  for (const ch of name) {
    // A separator becomes a hyphen rather than nothing: "a/b" must not quietly
    // become one word, and it must not stay a path — an entry name that climbs
    // out of its folder is the classic zip-slip.
    if (SEPARATORS.includes(ch)) {
      out += "-";
      continue;
    }
    if (RESERVED.has(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }

  // A leading dot hides the file on Unix; a trailing one is dropped by Windows,
  // which turns two distinct names into one collision.
  while (out.startsWith(".")) out = out.slice(1);
  while (out.endsWith(".")) out = out.slice(0, -1);

  const collapsed = out.split(/\s+/).join(" ").trim().slice(0, 100).trim();
  return collapsed || fallback;
}
