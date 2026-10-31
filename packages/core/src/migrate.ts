// Applies migrations/*.sql in name order, once each. Usage: DATABASE_URL=... node src/migrate.ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export async function migrate(databaseUrl: string): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const file of files) {
      if ((await client.query("select 1 from schema_migrations where name = $1", [file])).rowCount) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (cause) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const applied = await migrate(url);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
}
