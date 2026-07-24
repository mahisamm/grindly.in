import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const dockerfile = fs.readFileSync(
  path.join(__dirname, "..", "..", "Dockerfile.worker"),
  "utf8",
);

describe("worker resume compiler regression", () => {
  it("installs and verifies the compiler required by resume optimization", () => {
    expect(dockerfile).toContain("ARG TECTONIC_VERSION=0.16.9");
    expect(dockerfile).toContain("tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz");
    expect(dockerfile).toContain("tectonic --version");
  });
});
