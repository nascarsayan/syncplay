import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import path from "path";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "syncplay.db");
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3000";

const emails = process.argv.slice(2).map((v) => v.trim().toLowerCase()).filter(Boolean);
if (emails.length === 0) {
  console.error("Usage: bun run invite -- email1@example.com email2@example.com");
  process.exit(1);
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    email TEXT,
    uses_remaining INTEGER NOT NULL,
    expires_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

for (const email of emails) {
  const token = randomToken(24);
  db.query(
    `INSERT INTO invites (token, email, uses_remaining, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, email, 1, null, "cli", nowIso());

  console.log(`${email} -> ${APP_BASE_URL}/invite/${token}`);
}
