import { applySchema } from "./apply-schema.js";
import { closePool } from "./pool.js";

/* CLI entrypoint for the signal-schema migration. Run with: npm run db:migrate.
   The same idempotent DDL also runs automatically on server startup. */

try {
  await applySchema();
  console.log('✓ Signal schema applied (signal."User").');
} catch (err) {
  console.error("✗ Migration failed:", (err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
