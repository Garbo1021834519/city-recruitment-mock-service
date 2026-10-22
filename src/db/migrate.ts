import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection.js";

export function migrateDatabase(db: DatabaseSync): void {
  const migrationDirectory = path.resolve(process.cwd(), "src", "db", "migrations");
  const files = fs.readdirSync(migrationDirectory).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("BEGIN");
  try {
    for (const file of files) {
      const version = Number(file.slice(0, file.indexOf("_")));
      const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
      if (!applied) {
        db.exec(fs.readFileSync(path.join(migrationDirectory, file), "utf8"));
        db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase();
  migrateDatabase(db);
  db.close();
  console.log("migrations applied");
}
