import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockErrorEvent } = vi.hoisted(() => ({
  mockErrorEvent: { upsert: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { errorEvent: mockErrorEvent } }));

import { describeThrown, fingerprintKey, recordError } from "@/lib/errors";

beforeEach(() => {
  vi.resetAllMocks();
  mockErrorEvent.upsert.mockResolvedValue({});
});

describe("fingerprintKey", () => {
  it("collapses the same fault on different records into one row", () => {
    // The property the whole table depends on. Without it, one broken code path
    // hit by four hundred users is four hundred rows, and the admin page stops
    // being read.
    expect(fingerprintKey("web", "resume cm3x8k2p0000abcd not found")).toBe(
      fingerprintKey("web", "resume cm9zzz1q1111efgh not found"),
    );
  });

  it("collapses numbers, quoted strings and casing", () => {
    expect(fingerprintKey("agent", "variants exited with code 137")).toBe(
      fingerprintKey("agent", "variants exited with code 1"),
    );
    expect(fingerprintKey("agent", 'could not open "/data/a.pdf"')).toBe(
      fingerprintKey("agent", 'could not open "/data/b.pdf"'),
    );
    expect(fingerprintKey("web", "Database Unreachable")).toBe(
      fingerprintKey("web", "database unreachable"),
    );
  });

  it("keeps genuinely different faults apart", () => {
    expect(fingerprintKey("web", "database unreachable")).not.toBe(
      fingerprintKey("web", "renderer missing"),
    );
    // Same message, different kind: a timeout in `report` and a timeout in
    // `variants` are different problems with different fixes.
    expect(fingerprintKey("report-failed", "timed out")).not.toBe(
      fingerprintKey("variants-failed", "timed out"),
    );
  });
});

describe("recordError", () => {
  it("increments rather than inserting a second row", async () => {
    await recordError({ source: "web", kind: "server-error", message: "boom" });
    const call = mockErrorEvent.upsert.mock.calls[0][0];
    expect(call.update.count).toEqual({ increment: 1 });
    expect(call.where.fingerprint).toBe(fingerprintKey("server-error", "boom"));
  });

  it("un-resolves a fault that has come back", async () => {
    // "I marked this fixed" and "this stopped happening" are different claims.
    // Only the second one is evidence, so a recurrence clears the flag.
    await recordError({ source: "agent", kind: "timeout", message: "variants timed out" });
    expect(mockErrorEvent.upsert.mock.calls[0][0].update.resolvedAt).toBe(null);
  });

  it("truncates a stack rather than storing an archive", async () => {
    await recordError({
      source: "web",
      kind: "server-error",
      message: "x".repeat(5000),
      stack: "y".repeat(50_000),
    });
    const create = mockErrorEvent.upsert.mock.calls[0][0].create;
    expect(create.message.length).toBeLessThanOrEqual(1000);
    expect(create.stack.length).toBeLessThanOrEqual(4000);
  });

  it("never throws when the database is the thing that is broken", async () => {
    // This is called from catch blocks, including ones already handling a
    // database failure. If it could throw, it would replace a handled error
    // with an unhandled one.
    mockErrorEvent.upsert.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordError({ source: "web", kind: "server-error", message: "boom" }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("stores something for an error with no message at all", async () => {
    await recordError({ source: "web", kind: "", message: "" });
    const create = mockErrorEvent.upsert.mock.calls[0][0].create;
    expect(create.kind).toBe("error");
    expect(create.message).toBe("(no message)");
  });
});

describe("describeThrown", () => {
  it("reads an Error", () => {
    const described = describeThrown(new TypeError("bad shape"));
    expect(described.kind).toBe("TypeError");
    expect(described.message).toBe("bad shape");
  });

  it("survives the things people actually throw", () => {
    expect(describeThrown("just a string").message).toBe("just a string");
    expect(describeThrown({ code: 42 }).message).toBe('{"code":42}');
  });
});

describe("fingerprintKey — the id shapes this application actually produces", () => {
  it("collapses cuids, which are not hex", () => {
    // The first version of the normaliser only matched hex runs, so every cuid
    // in a message survived it and one fault became one row per record.
    expect(fingerprintKey("web", "variant clx9k2p8a0001qz3f not found")).toBe(
      fingerprintKey("web", "variant cm4b2z9x1000ab7yt not found"),
    );
  });

  it("collapses uuids", () => {
    expect(
      fingerprintKey("agent", "run 3f9a1c22-4b7e-4a11-9d3e-7c1a5b8e2f60 failed"),
    ).toBe(fingerprintKey("agent", "run 88c0de11-2222-4aaa-8bbb-999999999999 failed"));
  });

  it("leaves ordinary long words alone", () => {
    // No digit, so not an id. If these collapsed, two genuinely different
    // faults would share a row and one of them would be invisible.
    expect(fingerprintKey("web", "authentication unavailable")).not.toBe(
      fingerprintKey("web", "unauthenticated unavailable"),
    );
  });
});
