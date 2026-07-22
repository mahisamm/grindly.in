import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSupportAI, supportAssist } from "@/lib/supportAI";

describe("parseSupportAI", () => {
  it("parses a clean JSON object", () => {
    const r = parseSupportAI(
      JSON.stringify({ reply: "Hi", subject: "S", category: "bug", severity: "high", summary: "sum" }),
    );
    expect(r).toEqual({ reply: "Hi", offTopic: false, subject: "S", category: "bug", severity: "high", summary: "sum" });
  });

  it("flags offTopic when the model sets it, and defaults it to false", () => {
    const on = parseSupportAI(
      JSON.stringify({ reply: "no", offTopic: true, subject: "s", category: "other", severity: "low", summary: "z" }),
    );
    expect(on?.offTopic).toBe(true);
    const off = parseSupportAI(
      JSON.stringify({ reply: "yes", subject: "s", category: "bug", severity: "low", summary: "z" }),
    );
    expect(off?.offTopic).toBe(false);
  });

  it("unwraps ```json fences and surrounding prose", () => {
    const raw =
      'Sure:\n```json\n{"reply":"Hello","subject":"T","category":"how_to","severity":"low","summary":"x"}\n``` done';
    const r = parseSupportAI(raw);
    expect(r?.reply).toBe("Hello");
    expect(r?.category).toBe("how_to");
  });

  it("coerces an unknown category/severity to safe defaults", () => {
    const r = parseSupportAI(
      JSON.stringify({ reply: "y", subject: "s", category: "nonsense", severity: "boom", summary: "z" }),
    );
    expect(r?.category).toBe("other");
    expect(r?.severity).toBe("normal");
  });

  it("returns null when there is no usable reply", () => {
    expect(parseSupportAI(JSON.stringify({ subject: "s" }))).toBeNull();
    expect(parseSupportAI("not json at all")).toBeNull();
  });

  it("defaults the summary from the reply when it is missing", () => {
    const r = parseSupportAI(
      JSON.stringify({ reply: "the reply text", subject: "s", category: "bug", severity: "low" }),
    );
    expect(r?.summary).toBe("the reply text");
  });
});

describe("supportAssist", () => {
  const ENV = { ...process.env };
  const history = [{ role: "user" as const, content: "help", at: "2026-01-01T00:00:00Z" }];

  beforeEach(() => { process.env.GROQ_API_KEY = "test-key"; });
  afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

  it("returns null when no API key is configured", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    expect(await supportAssist("ctx", history)).toBeNull();
  });

  it("returns null when history is empty", async () => {
    expect(await supportAssist("ctx", [])).toBeNull();
  });

  it("returns the parsed assistant result on a good response", async () => {
    const content = JSON.stringify({
      reply: "Try reconnecting", subject: "Login", category: "how_to", severity: "normal", summary: "User login issue",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    }));
    const r = await supportAssist("ctx", history);
    expect(r?.reply).toBe("Try reconnecting");
    expect(r?.category).toBe("how_to");
  });

  it("returns null when the provider responds not-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await supportAssist("ctx", history)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await supportAssist("ctx", history)).toBeNull();
  });
});
