import "dotenv/config";
import pg from "pg";

/* PostgreSQL pool — the SAME database as the TradingBackend. The signal app
   owns the "signal" schema and only reads the trading tables. */

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      console.warn(`[pg] idle client error (will reconnect): ${err.message}`);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
