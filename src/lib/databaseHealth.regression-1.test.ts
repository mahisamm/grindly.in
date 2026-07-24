import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
  },
}));

import { databaseSchemaReady, REQUIRED_DATABASE_TABLES } from "./databaseHealth";

describe("databaseSchemaReady regression", () => {
  beforeEach(() => queryRaw.mockReset());

  it("accepts a database containing every table required by this build", async () => {
    queryRaw.mockResolvedValue(
      REQUIRED_DATABASE_TABLES.map((table_name) => ({ table_name })),
    );

    await expect(databaseSchemaReady()).resolves.toBe(true);
  });

  it("rejects schema drift even when the users table exists", async () => {
    queryRaw.mockResolvedValue(
      REQUIRED_DATABASE_TABLES
        .filter((table) => table !== "company_reputation")
        .map((table_name) => ({ table_name })),
    );

    await expect(databaseSchemaReady()).resolves.toBe(false);
  });
});
