/* Admin trade-readiness endpoints, driven over real HTTP.
 *
 * The routing and the admin check are the parts worth testing here — the gate's
 * own logic is covered in readiness.test.ts. What must hold: the view is
 * ADMIN-ONLY (it exposes every subscriber's account state), and the re-check is
 * POST-only, because it places a real order and must never be reachable by a
 * page load or a crawler following a GET.
 *
 * Run: npx tsx src/dxfeed/readiness-api.test.ts
 */

import type { AddressInfo } from "node:net";
import { getPool, closePool } from "../db/pool.js";
import { applySchema } from "../db/apply-schema.js";
import { createSignalServer } from "../server/server.js";
import { signToken } from "../auth/service.js";
import { upsertDxFeedLink, deleteDxFeedLink, markTradeVerified } from "./store.js";
import { setTradingClient } from "./trading-client.js";
import { AccountStatus } from "./types.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

interface ReadinessRowJson {
  userId: string; email: string; dxAccountId: string | null;
  tradeVerifiedAt: string | null; tradeProbeError: string | null;
}

async function main(): Promise<void> {
  await applySchema();
  const pool = getPool();
  // No trading session in a test: the probe must come back inconclusive rather
  // than trying to reach dxFeed.
  setTradingClient(null);

  const server = createSignalServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const ids: string[] = [];
  const mkUser = async (role: "ADMIN" | "SUBSCRIBER", tag: string): Promise<{ id: string; token: string; email: string }> => {
    const email = `readiness-api-${tag}-${Date.now()}@example.com`;
    const { rows } = await pool.query(
      `INSERT INTO "signal"."User" ("email","passwordHash","name","role","status")
       VALUES ($1,'x','Readiness API',$2,'ACTIVE') RETURNING "id"`,
      [email, role],
    );
    const id = rows[0].id as string;
    ids.push(id);
    return { id, token: signToken({ id, email, role } as Parameters<typeof signToken>[0]), email };
  };

  try {
    console.log("\nadmin trade-readiness API\n");

    const admin = await mkUser("ADMIN", "admin");
    const plain = await mkUser("SUBSCRIBER", "plain");
    const linked = await mkUser("SUBSCRIBER", "linked");
    const verified = await mkUser("SUBSCRIBER", "verified");

    for (const u of [linked, verified]) {
      await upsertDxFeedLink({
        userId: u.id, dxUserId: `dx-${u.id}`, dxAccountId: `acct-${u.id}`,
        dxSubscriptionId: null, accountStatus: AccountStatus.ENABLED, subscriptionStatus: null,
        agreementSigned: true, agreementLink: null, platform: null,
      });
    }
    await markTradeVerified(verified.id);

    const get = (token?: string): Promise<Response> =>
      fetch(`${base}/api/admin/dxfeed/readiness`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

    // --- the view is admin-only ---------------------------------------------
    check("an anonymous caller is refused", (await get()).status === 403);
    check("a non-admin subscriber is refused", (await get(plain.token)).status === 403);

    const res = await get(admin.token);
    check("an admin gets the view", res.status === 200, `${res.status}`);
    const view = (await res.json()) as { adapter: string; rows: ReadinessRowJson[] };
    const rows = view.rows;

    // The UI hides itself entirely when this is "atas", so it has to be reported.
    check("the view reports which execution adapter is live",
      view.adapter === "atas" || view.adapter === "dxfeed", view.adapter);

    const linkedRow = rows.find((r) => r.userId === linked.id);
    const verifiedRow = rows.find((r) => r.userId === verified.id);
    check("a linked subscriber appears", !!linkedRow);
    // An unprovisioned subscriber is exactly who an admin needs to act on, so
    // they must appear too — with no account rather than not at all.
    const plainRow = rows.find((r) => r.userId === plain.id);
    check("an unprovisioned subscriber also appears", !!plainRow);
    check("and shows as having no dxFeed account", plainRow?.dxAccountId == null);
    check("admins are not listed as subscribers", !rows.some((r) => r.userId === admin.id));
    check("the unverified one reads as unverified", linkedRow?.tradeVerifiedAt === null);
    check("the verified one carries its timestamp", !!verifiedRow?.tradeVerifiedAt);

    // Not-tradeable first: those are the subscribers whose signals are being
    // skipped, so they are what an admin opening this page needs to see.
    const firstVerifiedAt = rows.findIndex((r) => r.tradeVerifiedAt !== null);
    const lastUnverifiedAt = rows.map((r) => r.tradeVerifiedAt === null).lastIndexOf(true);
    check("not-tradeable subscribers sort first",
      firstVerifiedAt === -1 || lastUnverifiedAt < firstVerifiedAt,
      `firstVerified=${firstVerifiedAt} lastUnverified=${lastUnverifiedAt}`);

    // --- the re-check places an order, so it is POST-only and admin-only -----
    const recheck = (userId: string, token?: string, method = "POST"): Promise<Response> =>
      fetch(`${base}/api/admin/dxfeed/readiness/${userId}`, {
        method, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });

    check("a non-admin cannot trigger a re-check", (await recheck(linked.id, plain.token)).status === 403);
    check("an anonymous caller cannot trigger a re-check", (await recheck(linked.id)).status === 403);
    check("a GET does not trigger a re-check", (await recheck(linked.id, admin.token, "GET")).status === 404);

    const probeRes = await recheck(linked.id, admin.token);
    check("an admin can trigger a re-check", probeRes.status === 200, `${probeRes.status}`);
    const probe = (await probeRes.json()) as { ready: boolean; reason: string | null; inconclusive?: boolean };
    check("with no trading session the verdict is inconclusive", probe.inconclusive === true, probe.reason ?? "");
    check("and it is not reported ready", probe.ready === false);

    // The subscriber was never verified, but an inconclusive verdict must not
    // record a failure against them either.
    const after = (await (await get(admin.token)).json()) as { rows: ReadinessRowJson[] };
    check("an inconclusive re-check records nothing against the subscriber",
      after.rows.find((r) => r.userId === linked.id)?.tradeProbeError == null);

    // --- provisioning creates a real prop-firm account, so it is locked down --
    const provision = (userId: string, token?: string, method = "POST"): Promise<Response> =>
      fetch(`${base}/api/admin/dxfeed/provision/${userId}`, {
        method, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });

    check("a non-admin cannot provision", (await provision(plain.id, plain.token)).status === 403);
    check("an anonymous caller cannot provision", (await provision(plain.id)).status === 403);
    check("a GET does not provision", (await provision(plain.id, admin.token, "GET")).status === 404);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    for (const id of ids) {
      await deleteDxFeedLink(id);
      await pool.query(`DELETE FROM "signal"."User" WHERE "id" = $1`, [id]);
    }
    // fetch() keeps its sockets alive, so close() alone would hang waiting on
    // them. Drop them first, then let the loop drain naturally — calling
    // process.exit() here instead trips a libuv assertion on Windows by exiting
    // while these handles are still closing.
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => { console.error("\nreadiness API test failed:", err, "\n"); process.exitCode = 1; });
