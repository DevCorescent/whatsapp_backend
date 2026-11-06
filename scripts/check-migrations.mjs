#!/usr/bin/env node
/**
 * Compares the manual migrations with the database and names anything missing.
 *
 * Partial indexes and a few other things Prisma cannot express live in
 * `migrations/manual/` and are applied by hand, which means they can be forgotten. Two
 * were: the chatbot flows screen answered 500 for days because a column it selects had
 * never been added, and plan renewal would have failed at payment for the same reason.
 * Neither failure said anything about a migration — one looked like an outage and the
 * other had not been reached yet.
 *
 * Run before and after a deploy. Exits non-zero when something is missing, so it can
 * fail a pipeline rather than wait to be read.
 *
 *   node scripts/check-migrations.mjs
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const DIR = "libs/prisma/prisma/migrations/manual";

async function connect() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
      return client;
    } catch {
      try { await client.end(); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 2_500));
    }
  }
  throw new Error("Database unreachable after 5 attempts");
}

const db = await connect();

const columns = new Set(
  (await db.query(
    `SELECT table_name || '.' || column_name AS k
       FROM information_schema.columns WHERE table_schema = 'public'`,
  )).rows.map((r) => r.k),
);
const tables = new Set(
  (await db.query(
    `SELECT table_name AS k FROM information_schema.tables WHERE table_schema = 'public'`,
  )).rows.map((r) => r.k),
);

let missingCount = 0;

for (const file of fs.readdirSync(DIR).sort()) {
  if (!file.endsWith(".sql")) continue;
  const sql = fs.readFileSync(path.join(DIR, file), "utf8");
  const missing = [];

  for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?"?([a-zA-Z_]+)"?/gi)) {
    if (!tables.has(m[1])) missing.push(`table ${m[1]}`);
  }

  // Columns are checked against the table their own ALTER names, so a file touching
  // several tables is reported accurately rather than against the first one it mentions.
  for (const alter of sql.matchAll(/ALTER TABLE\s+(?:public\.)?"?([a-zA-Z_]+)"?([\s\S]*?);/gi)) {
    const table = alter[1];
    if (!tables.has(table)) continue;
    for (const col of alter[2].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+"([^"]+)"/gi)) {
      if (!columns.has(`${table}.${col[1]}`)) missing.push(`${table}.${col[1]}`);
    }
  }

  if (missing.length) {
    missingCount++;
    console.error(`NOT APPLIED  ${file}`);
    console.error(`     missing: ${missing.join(", ")}`);
  }
}

await db.end();

if (missingCount) {
  console.error(
    `\n${missingCount} migration${missingCount === 1 ? "" : "s"} not applied. Run each with:\n` +
    `  npx prisma db execute --schema libs/prisma/prisma/schema.prisma --file ${DIR}/<file>.sql`,
  );
  process.exit(1);
}

console.log("All manual migrations are applied.");
