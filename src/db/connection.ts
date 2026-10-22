import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDatabase(filename = path.resolve(process.cwd(), "data", "app.sqlite")): DatabaseSync {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
