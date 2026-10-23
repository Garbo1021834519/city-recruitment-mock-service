import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { parsePagination } from "../src/shared/pagination.js";

describe("SQLite migrations and seed", () => {
  it("creates every module table and seeds idempotently", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    expect(before.map((row) => row.name)).toEqual(expect.arrayContaining([
      "users", "cities", "factories", "service_positions", "knowledge_items", "activation_strategies",
      "jobs", "job_attempts", "job_locks",
    ]));
    seedDatabase(db);
    const first = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    seedDatabase(db);
    const second = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    expect(first).toBeGreaterThanOrEqual(3);
    expect(second).toBe(first);
  });
});

describe("parsePagination", () => {
  it("uses target page and page_size names and clamps unsafe values", () => {
    expect(parsePagination({ page: "2", page_size: "100" })).toEqual({ page: 2, pageSize: 100, offset: 100 });
    expect(parsePagination({ page: "0", page_size: "-5" })).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });
});
