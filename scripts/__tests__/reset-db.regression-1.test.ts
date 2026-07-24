import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

describe("reset-db model coverage regression", () => {
  it("deletes every model declared in the Prisma schema", () => {
    const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
    const script = fs.readFileSync(path.join(ROOT, "scripts", "reset-db.mjs"), "utf8");
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);

    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const delegate = model[0].toLowerCase() + model.slice(1);
      expect(
        script,
        `reset-db.mjs does not clear Prisma model ${model}`,
      ).toContain(`prisma.${delegate}.deleteMany()`);
    }
  });
});
