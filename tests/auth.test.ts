import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { AuthService } from "../src/auth/auth.service.js";

describe("AuthService", () => {
  it("logs in a seeded user and returns the target token shape", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    const service = new AuthService(db, "test-secret");
    const result = service.login("local-admin", "local-demo-only");
    expect(result.token_type).toBe("bearer");
    expect(result.access_token.split(".")).toHaveLength(3);
    expect(service.me(result.access_token)).toMatchObject({ username: "local-admin", role: "admin" });
  });

  it("rejects a bad password and a recruiter token for admin routes", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    const service = new AuthService(db, "test-secret");
    expect(() => service.login("local-admin", "wrong")).toThrow("用户名或密码错误");
    const token = service.login("local-recruiter", "local-demo-only").access_token;
    expect(service.me(token)).toMatchObject({ role: "recruiter" });
    expect(service.authorize(token, ["admin"])).toBe(false);
  });
});
