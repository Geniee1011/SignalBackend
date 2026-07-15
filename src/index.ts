import { config, useDatabase } from "./config.js";
import { createSignalServer } from "./server/server.js";
import { ensureAdmin } from "./auth/service.js";
import { applySchema } from "./db/apply-schema.js";

if (!useDatabase) {
  console.error("[fatal] DATABASE_URL is not set — the signal app needs the shared trading database to read trades from.");
  process.exit(1);
}

// Ensure the signal schema + access columns exist before anything queries them
// (idempotent). This removes the need for a separate migration step on deploy —
// without it, the very first login 500s because signal."User" doesn't exist.
try {
  await applySchema();
  console.log('[db] signal schema ready');
} catch (e) {
  console.error("[db] schema apply FAILED — auth/signals will error until this succeeds:", (e as Error).message);
}

// Bootstrap/promote the admin account so the admin dashboard is reachable.
const adminEmail = process.env.SIGNAL_ADMIN_EMAIL?.trim();
const adminPass = process.env.SIGNAL_ADMIN_PASSWORD;
if (adminEmail && adminPass) {
  await ensureAdmin(adminEmail, adminPass).catch((e) => console.error("[admin] bootstrap failed:", (e as Error).message));
}

const server = createSignalServer();

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[fatal] Port ${config.port} is already in use. Stop the other process or set PORT.\n`);
    process.exit(1);
  }
  console.error("[fatal] server error:", err);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`SignalBackend listening on http://localhost:${config.port}`);
  console.log(`  WebSocket   ws://localhost:${config.port}/ws`);
  console.log(`  Signals     GET http://localhost:${config.port}/api/signals`);
  console.log(`  Performance GET http://localhost:${config.port}/api/performance`);
  console.log(`  Auth        POST /api/auth/register · POST /api/auth/login · GET /api/auth/me`);
});

function shutdown() {
  console.log("\nShutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
