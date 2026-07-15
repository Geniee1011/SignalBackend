import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool } from "./pool.js";

/* Apply the signal-schema DDL. Only ever touches the "signal" schema — never the
   trading platform's tables. Idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF
   NOT EXISTS), so it's safe to run on every boot as well as via the CLI. */

const here = dirname(fileURLToPath(import.meta.url));

export async function applySchema(): Promise<void> {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await getPool().query(sql);
}
