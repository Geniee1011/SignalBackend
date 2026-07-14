import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "./pool.js";

/* Apply the signal-schema DDL. Only ever touches the "signal" schema — never the
   trading platform's tables. Run with: npm run db:migrate */

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema.sql"), "utf8");

try {
  await getPool().query(sql);
  console.log('✓ Signal schema applied (signal."User").');
} catch (err) {
  console.error("✗ Migration failed:", (err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
