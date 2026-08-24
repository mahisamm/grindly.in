import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { mockSpawn, mockReport } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockReport: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("@/lib/errors", () => ({ report: mockReport }));

import { providerFailureFromLine, runAgent } from "../agent";

/** The parts of a ChildProcess that runAgent touches, with nothing behind them. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

/** A PassThrough delivers `data` on a later tick; this waits for it. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Every `ok: false` that leaves runAgent must also reach the error table —
 * three of them did not, so a missing interpreter, a runaway process and a
 * reply with no `ok` field each failed the user without telling /admin.
 */
describe("runAgent reports every failure it returns", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockReport.mockReset();
  });

  it("reports a spawn that throws synchronously", async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const result = await runAgent("health");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not start Python/);
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent", kind: "spawn-failed", context: "health" }),
    );
  });

  it("reports JSON that has no ok field", async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);
    const pending = runAgent("health");
    child.stdout.write('{"score": 71}');
    await tick();
    child.emit("close", 0);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unexpected shape/);
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent", kind: "bad-shape", context: "health" }),
    );
  });

  it("reports and kills a process that floods stdout", async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);
    const pending = runAgent("health");
    child.stdout.write("x".repeat(12 * 1024 * 1024 + 1));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/implausible amount of output/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent", kind: "output-too-large", context: "health" }),
    );
  });
});

/**
 * The agent's stderr is the only place a dead LLM provider is observable, and
 * `/admin` counts what gets lifted from it. What is lifted decides whether the
 * "N errors" badge means anything: four free-tier 429 rows sat there for days
 * as "errors" while nothing was wrong.
 */
describe("providerFailureFromLine", () => {
  it("lifts a provider failure with provider and reason", () => {
    expect(
      providerFailureFromLine(
        "[llm] https://api.groq.com/openai/v1 (openai/gpt-oss-20b) error: HTTP Error 413: Payload Too Large — Limit 8000, Requested 8412",
      ),
    ).toBe(
      "https://api.groq.com/openai/v1 (openai/gpt-oss-20b) — HTTP Error 413: Payload Too Large — Limit 8000, Requested 8412",
    );
    expect(providerFailureFromLine("[llm] Gemini error: HTTP Error 404: Not Found")).toBe(
      "Gemini — HTTP Error 404: Not Found",
    );
  });

  it("lifts the retirements this table exists for", () => {
    expect(providerFailureFromLine("[llm] provider cerebras error: HTTP Error 402: Payment Required")).toContain(
      "402",
    );
    expect(
      providerFailureFromLine("[llm] https://api.groq.com/openai/v1 (llama-3.3-70b) error: The model does not exist"),
    ).toContain("does not exist");
  });

  it("does not lift a free tier answering 429 — that is the tier working, not failing", () => {
    expect(
      providerFailureFromLine("[llm] Gemini error: HTTP Error 429: Too Many Requests"),
    ).toBeNull();
    expect(
      providerFailureFromLine(
        "[llm] https://openrouter.ai/api/v1 (google/gemma-4-26b-a4b-it:free) error: HTTP Error 429: Too Many Requests — rate limited, retry after 20s",
      ),
    ).toBeNull();
  });

  it("ignores every other stderr line", () => {
    expect(providerFailureFromLine("[llm] ensemble OK groq-gpt-oss-20b")).toBeNull();
    expect(providerFailureFromLine("[llm] groq skipped — prompt ~8064 tokens leaves no completion room")).toBeNull();
    expect(providerFailureFromLine("[progress] Rendering")).toBeNull();
    expect(providerFailureFromLine("Traceback (most recent call last): error: x")).toBeNull();
    expect(providerFailureFromLine("")).toBeNull();
  });

  it("bounds the message", () => {
    const out = providerFailureFromLine(`[llm] p error: ${"x".repeat(1000)}`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(400);
  });
});
