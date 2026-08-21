/* B14 — can we CREATE the fullTrading SYSTEM credential ourselves?
 *
 * Run: npx tsx src/dxfeed/system-credential.smoke.ts            (dry run — prints the payload)
 *      npx tsx src/dxfeed/system-credential.smoke.ts --confirm  (actually creates it)
 *      … [--email=you@example.com] [--keep]
 *
 * Background: Volumetrica issued us a per-USER web-platform login, which trades
 * only its own account. Production copy execution needs ONE session that can
 * trade every subscriber account — a `userType=1 (System)` +
 * `systemAccess=2 (FullTrading)` credential. The live Propfirm Swagger exposes
 * both fields on NewUser, so we may be able to mint it without waiting on email.
 *
 * This is the one dxFeed smoke that CREATES A PERSISTENT ENTITY, hence --confirm.
 * It places no orders: it creates the credential, then does exactly what the copy
 * engine would do first — POST it to the Admin Trading API auth endpoint — and
 * reports whether that returns a token. Nothing here can move money.
 *
 * On success, put the printed login/password into SignalBackend/.env as
 * DXFEED_SYSTEM_LOGIN / DXFEED_SYSTEM_PASSWORD. The password is shown ONCE.
 */

import { randomBytes } from "node:crypto";
import { config, dxfeedReady } from "../config.js";
import { propfirm, DxFeedApiError } from "./propfirm.js";
import { parseAuthResponse } from "./trading-auth.js";
import { UserType, SystemAccess, EncryptionMode } from "./types.js";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const KEEP = args.includes("--keep");
const FIX_PLATFORM = args.includes("--fix-platform");
const emailArg = args.find((a) => a.startsWith("--email="))?.split("=")[1];

/** Strong password for the credential — printed once, never persisted by us. */
function makePassword(): string {
  // Base64url minus lookalikes; the platform rejects some punctuation.
  const raw = randomBytes(18).toString("base64").replace(/[+/=]/g, "");
  return `Sys${raw.slice(0, 16)}!7`;
}

/** Auth exactly as the copy engine would, with an explicit credential. */
async function tryTradingAuth(login: string, password: string): Promise<string> {
  const t = config.dxfeed.trading;
  const res = await fetch(t.authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", PltfKey: t.pltfKey },
    body: JSON.stringify({
      login, password,
      environment: config.dxfeed.environment,
      withDetails: true,
      connectOnlyTrading: true,
      version: t.apiVersion,
    }),
  });
  const text = await res.text();
  let body: unknown = {};
  try { body = JSON.parse(text); } catch { /* non-JSON body — surfaced below */ }
  try {
    const auth = parseAuthResponse(res.ok, res.headers.get("wss"), body);
    return `OK — token ${auth.token.length} chars, wss ${new URL(auth.wssEndpoint).host}`;
  } catch (err) {
    return `REJECTED (HTTP ${res.status}) — ${(err as Error).message} | raw: ${text.slice(0, 200)}`;
  }
}

async function main(): Promise<void> {
  console.log("\ndxFeed — create a fullTrading SYSTEM credential via the Propfirm API\n");

  if (!dxfeedReady) {
    console.error("SKIPPED: DXFEED_API_KEY is not set in SignalBackend/.env.");
    process.exit(1);
  }

  // --fix-platform: UPDATE an existing user rather than minting another one.
  // NewUser is documented as "create or update user details", so re-posting the
  // same email carries the new flag onto the user we already have. No password is
  // sent — that would rotate a credential already sitting in .env.
  if (FIX_PLATFORM) {
    if (!emailArg) {
      console.error("--fix-platform needs --email=<the existing system login>\n");
      process.exit(1);
    }
    const patch = {
      firstName: "Copy",
      lastName: "System",
      email: emailArg,
      country: config.dxfeed.provisioning.country,
      userType: UserType.SYSTEM,
      systemAccess: SystemAccess.FULL_TRADING,
      overrideWebPlatform: true,
      extEntityId: "signalbackend-copy-system",
    };
    console.log("  mode        : --fix-platform (update, no new user, no password change)");
    console.log("  payload     : " + JSON.stringify(patch, null, 2).replace(/\n/g, "\n                "));
    if (!CONFIRM) {
      console.log("\nDRY RUN — nothing was changed. Re-run with --confirm.\n");
      return;
    }
    try {
      const updated = await propfirm.newUser(patch);
      console.log("\nNewUser(update) OK");
      console.log(`  userId      : ${updated.userId}`);
      console.log(`  username    : ${updated.username ?? "(none returned)"}`);
      console.log("\nRe-run the order smoke to see whether OrderInsert is now answered:");
      console.log("  npx tsx src/dxfeed/order.smoke.ts --confirm --account=<n> --no-market\n");
    } catch (err) {
      if (err instanceof DxFeedApiError) {
        console.error(`\nNewUser(update) REJECTED (HTTP ${err.status})`);
        console.error(`  ${err.body.slice(0, 400)}`);
        console.error("\nIf it names overrideWebPlatform, the flag is not settable here and");
        console.error("the platform choice must come from Volumetrica or the dashboard.\n");
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const email = emailArg ?? `copy-system-${stamp}@signals.app`;
  const password = makePassword();

  const input = {
    firstName: "Copy",
    lastName: "System",
    email,
    country: config.dxfeed.provisioning.country,
    userType: UserType.SYSTEM,
    systemAccess: SystemAccess.FULL_TRADING,
    encryptionMode: EncryptionMode.NONE,
    passwordToSet: password,
    forceNewPassword: false,
    extEntityId: "signalbackend-copy-system",
  };

  console.log("  propfirm    : " + config.dxfeed.propfirmUrl);
  console.log("  environment : " + config.dxfeed.environment + " (1 = staging)");
  console.log("  payload     : " + JSON.stringify({ ...input, passwordToSet: "***" }, null, 2).replace(/\n/g, "\n                "));

  if (!CONFIRM) {
    console.log("\nDRY RUN — nothing was created. Re-run with --confirm to create it.\n");
    return;
  }

  // --- 1. create the system user ------------------------------------------
  let user;
  try {
    user = await propfirm.newUser(input);
  } catch (err) {
    if (err instanceof DxFeedApiError) {
      console.error(`\nSTEP 1  NewUser REJECTED (HTTP ${err.status})`);
      console.error(`  ${err.body.slice(0, 400)}`);
      console.error("\nIf the rejection names userType/systemAccess, the API will not let us");
      console.error("mint system credentials and Volumetrica must issue one.\n");
      process.exit(1);
    }
    throw err;
  }

  console.log("\nSTEP 1  NewUser OK");
  console.log(`  userId      : ${user.userId}`);
  console.log(`  username    : ${user.username ?? "(none returned)"}`);
  console.log(`  password    : ${user.password ?? "(not returned — using the one we set)"}`);
  console.log(`  encryption  : ${user.encryptionMode}`);

  // The login is whatever the platform assigned; fall back to what we sent.
  const login = user.username ?? email;
  const pw = user.encryptionMode === EncryptionMode.NONE ? (user.password ?? password) : password;

  // --- 2. does it authenticate against the Admin Trading API? --------------
  console.log("\nSTEP 2  Admin Trading API auth with the new credential");
  console.log(`  login       : ${login}`);
  console.log(`  result      : ${await tryTradingAuth(login, pw)}`);

  console.log("\n--- CREDENTIAL (shown once) ---");
  console.log(`  DXFEED_SYSTEM_LOGIN=${login}`);
  console.log(`  DXFEED_SYSTEM_PASSWORD=${pw}`);
  console.log("-------------------------------");

  if (!KEEP) {
    console.log("\nNOTE: this user was created on staging and is NOT cleaned up automatically");
    console.log("(deleting a user needs its accounts removed first). Remove it in the dashboard");
    console.log("if the auth above was rejected.\n");
  }
}

main().catch((err) => {
  console.error("\nfailed:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
