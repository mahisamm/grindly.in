import { describe, expect, it } from "vitest";
import { providerFailureFromLine } from "../agent";

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
