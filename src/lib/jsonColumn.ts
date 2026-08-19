/**
 * Writing a typed object into a `jsonb` column.
 *
 * Prisma's `InputJsonValue` is a structural type: an object literal satisfies
 * it only if every property is itself an `InputJsonValue`. A `Report` does not,
 * because `facts` is `Record<string, Record<string, unknown>>` and `unknown` is
 * not assignable to it — even though the value is, in fact, a plain tree that
 * came out of `JSON.parse` moments earlier and is about to be serialised again.
 *
 * The alternative to this helper is an inline `as Prisma.InputJsonValue` at
 * every write site, which is the same assertion made repeatedly and without an
 * explanation attached. This is that assertion, once, with the reason.
 *
 * `null` is the other half of it. Prisma distinguishes "the column is SQL NULL"
 * (`Prisma.DbNull`) from "the column holds the JSON value null"
 * (`Prisma.JsonNull`), and a bare `null` is a type error precisely so nobody
 * picks one by accident. Everywhere in this app an absent report means the
 * column is empty, so it is DbNull.
 */
import { Prisma } from "@prisma/client";

export function toJsonColumn(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/**
 * The same assertion for a column that is NOT nullable.
 *
 * A required `Json` column's input type excludes `DbNull` — there is no SQL
 * NULL to write — so `toJsonColumn` cannot be used for one. `Resume.skillsJson`
 * is the case: it defaults to `[]` and every writer supplies a real array.
 */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return (value ?? null) as Prisma.InputJsonValue;
}
