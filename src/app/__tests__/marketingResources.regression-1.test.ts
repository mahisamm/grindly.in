import { describe, expect, it } from "vitest";
import { MARKETING_RESOURCES, marketingResource } from "@/lib/marketing";

describe("marketing resources", () => {
  it("keeps every indexed guide substantive and uniquely addressable", () => {
    expect(MARKETING_RESOURCES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(MARKETING_RESOURCES.map((resource) => resource.slug)).size).toBe(MARKETING_RESOURCES.length);

    for (const resource of MARKETING_RESOURCES) {
      expect(resource.title.length).toBeGreaterThan(24);
      expect(resource.sections.length).toBeGreaterThanOrEqual(3);
      expect(resource.questions.length).toBeGreaterThanOrEqual(2);
      expect(marketingResource(resource.slug)).toBe(resource);
    }
  });

  it("does not resolve invented guide paths", () => {
    expect(marketingResource("a-secret-ats-score")).toBeUndefined();
  });
});
