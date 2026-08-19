import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every table and column in schema.prisma must exist in prisma/migrations.
 *
 * `prisma migrate deploy` applies the SQL in that directory and nothing else. A
 * model added to the schema without a matching migration therefore produces a
 * Prisma client that queries a column the database does not have — and it fails
 * at runtime, on the first request that touches it, in production, rather than
 * at deploy time. That is the failure mode this file exists to convert into a
 * red test.
 *
 * The check is deliberately textual rather than a real `migrate diff`: diff
 * needs a live shadow database, which CI would have to provision, and a test
 * that only runs where Postgres happens to be up is a test nobody trusts. Text
 * matching catches the case that actually happens — a new model or field with
 * no migration behind it. It will not catch a type change or a dropped default,
 * which is what the diff in the deploy runbook is for.
 */

const ROOT = path.join(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");

/** Every .sql file under prisma/migrations, concatenated. */
function migrationSql(): string {
  if (!fs.existsSync(MIGRATIONS)) return "";
  return fs
    .readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((dir) => {
      const file = path.join(MIGRATIONS, dir.name, "migration.sql");
      return fs.existsSync(file) ? [fs.readFileSync(file, "utf8")] : [];
    })
    .join("\n");
}

type Model = { name: string; table: string; columns: string[] };

/**
 * Pull models, their mapped table names and their mapped column names out of
 * the schema.
 *
 * Relation fields (`user User @relation(...)`) are skipped: they are not
 * columns. The foreign key beside them (`userId String @map("user_id")`) is a
 * separate field line and is picked up normally.
 */
function parseModels(schema: string): Model[] {
  const modelNames = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const models: Model[] = [];

  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    const tableMap = body.match(/@@map\("([^"]+)"\)/);
    const columns: string[] = [];

    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;

      const field = line.match(/^(\w+)\s+(\w+)(\[\])?\??/);
      if (!field) continue;
      const [, fieldName, fieldType, isList] = field;

      // A relation field, or a list of them: no column of its own.
      if (modelNames.includes(fieldType)) continue;
      if (isList) continue;

      const colMap = line.match(/@map\("([^"]+)"\)/);
      columns.push(colMap ? colMap[1] : fieldName);
    }

    models.push({ name, table: tableMap ? tableMap[1] : name, columns });
  }

  return models;
}

describe("migration coverage", () => {
  const schema = fs.readFileSync(SCHEMA, "utf8");
  const sql = migrationSql();
  const models = parseModels(schema);

  it("has a migrations directory with a provider lock", () => {
    expect(fs.existsSync(MIGRATIONS), "prisma/migrations is missing — run prisma migrate dev").toBe(true);
    expect(fs.existsSync(path.join(MIGRATIONS, "migration_lock.toml"))).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("parses the schema it is asserting against", () => {
    // Guards the parser itself: a regex that silently matches nothing would
    // make every assertion below vacuously pass.
    expect(models.length).toBeGreaterThan(5);
    for (const model of models) {
      expect(model.columns.length, `${model.name} parsed with no columns`).toBeGreaterThan(0);
    }
  });

  it("creates every model's table", () => {
    for (const model of models) {
      expect(
        sql,
        `no migration creates the table for model ${model.name} ("${model.table}")`,
      ).toContain(`CREATE TABLE "${model.table}"`);
    }
  });

  it("declares every model's columns", () => {
    for (const model of models) {
      for (const column of model.columns) {
        expect(
          sql,
          `no migration declares ${model.name}.${column} ("${column}")`,
        ).toContain(`"${column}"`);
      }
    }
  });
});
