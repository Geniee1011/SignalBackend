import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "../config.js";
import { register, login, verifyToken, getUserById, type TokenPayload } from "../auth/service.js";
import { getSignals } from "../signals/source.js";
import { getPerformance } from "../signals/performance.js";
import {
  applyAccess,
  getUserAccess,
  listUsersWithAccess,
  updateUserAccess,
  setUserStatus,
  sanitizeAccess,
  DEFAULT_ACCESS,
} from "../access/access.js";

/* Combined REST + WebSocket server for the signal app. Auth is fully separate
   from the trading platform (own JWT). Live signals are pushed over /ws by
   polling the shared DB and broadcasting on change (upgradeable to a direct
   TradingBackend WS relay / Postgres LISTEN-NOTIFY later). */

function cors(req: IncomingMessage, res: ServerResponse) {
  // CORS_ORIGIN may be "*" (any), a single origin, or a comma-separated allowlist
  // (e.g. the Vercel production domain + preview URLs). We reflect the request's
  // Origin when it's allowed so the browser accepts the response.
  const origin = req.headers.origin;
  const allow = config.corsOrigin.trim();
  let allowOrigin = "*";
  if (allow !== "*") {
    const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
    allowOrigin = origin && list.includes(origin) ? origin : (list[0] ?? "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  // PUT/PATCH are needed by the admin access editor; without them its preflight fails.
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}") as T); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function requireUser(req: IncomingMessage): TokenPayload | null {
  return verifyToken(bearer(req) ?? "");
}

/** Verify the caller is an ADMIN (role checked against the DB, not just the token). */
async function requireAdmin(req: IncomingMessage): Promise<TokenPayload | null> {
  const payload = requireUser(req);
  if (!payload) return null;
  const user = await getUserById(payload.sub);
  return user && user.role === "ADMIN" ? payload : null;
}

export function createSignalServer() {
  const http = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((err) => {
      console.error("[server] handler error:", (err as Error).message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  // --- WebSocket: broadcast the live signal set on change, filtered per user ---
  // Each connection carries the subscriber's id (?token=…). The base signal set is
  // computed once per tick; each client receives it through THEIR access config, so
  // a NQ-only user never sees ES over the socket. Unauthenticated sockets get the
  // default (all) view but the REST endpoints remain the authoritative, gated path.
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  const uidOf = (ws: WebSocket): string | null => (ws as WebSocket & { _uid?: string | null })._uid ?? null;
  const sendFiltered = async (ws: WebSocket, signals: Awaited<ReturnType<typeof getSignals>>) => {
    const uid = uidOf(ws);
    const access = uid ? await getUserAccess(uid) : DEFAULT_ACCESS;
    ws.send(JSON.stringify({ type: "signals", data: applyAccess(signals, access) }));
  };
  let lastHash = "";
  const broadcast = async () => {
    if (wss.clients.size === 0) return;
    try {
      const signals = await getSignals();
      const hash = JSON.stringify(signals.map((s) => [s.id, s.status, s.exit, s.stopLoss, s.takeProfit]));
      if (hash === lastHash) return;
      lastHash = hash;
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) await sendFiltered(c, signals);
    } catch (err) {
      console.warn("[ws] broadcast failed:", (err as Error).message);
    }
  };
  const timer = setInterval(() => void broadcast(), 3000);
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const payload = verifyToken(url.searchParams.get("token") ?? "");
    (ws as WebSocket & { _uid?: string | null })._uid = payload?.sub ?? null;
    void getSignals().then((signals) => sendFiltered(ws, signals)).catch(() => {});
  });
  http.on("close", () => clearInterval(timer));

  return http;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/health") return json(res, 200, { status: "ok", service: "signal-backend" });

  // --- auth ---
  if (path === "/api/auth/register" && req.method === "POST") {
    const body = await readJson<{ email?: string; password?: string; name?: string }>(req);
    const result = await register(body?.email ?? "", body?.password ?? "", body?.name);
    if ("error" in result) return json(res, 400, result);
    return json(res, 200, result);
  }
  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJson<{ email?: string; password?: string }>(req);
    const result = await login(body?.email ?? "", body?.password ?? "");
    if ("error" in result) return json(res, 401, result);
    return json(res, 200, result);
  }
  if (path === "/api/auth/me" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const user = await getUserById(payload.sub);
    if (!user) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { user });
  }

  // --- signals (auth required, gated by the caller's access) ---
  if (path === "/api/signals" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const hours = Number(url.searchParams.get("hours")) || config.signalWindowHours;
    const [signals, access] = await Promise.all([getSignals(hours), getUserAccess(payload.sub)]);
    return json(res, 200, applyAccess(signals, access));
  }
  if (path === "/api/performance" && req.method === "GET") {
    const payload = requireUser(req);
    if (!payload) return json(res, 401, { error: "unauthorized" });
    const sinceParam = url.searchParams.get("since");
    const market = url.searchParams.get("market") || undefined;
    const sinceMs = sinceParam ? Number(sinceParam) : undefined;
    const access = await getUserAccess(payload.sub);
    return json(res, 200, await getPerformance({ sinceMs, market, access }));
  }

  // --- admin (ADMIN role required) ---
  if (path === "/api/admin/users" && req.method === "GET") {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    return json(res, 200, await listUsersWithAccess());
  }
  if (path.startsWith("/api/admin/users/") && (req.method === "PUT" || req.method === "PATCH")) {
    if (!(await requireAdmin(req))) return json(res, 403, { error: "forbidden" });
    const id = decodeURIComponent(path.slice("/api/admin/users/".length).split("/")[0] ?? "");
    if (!id) return json(res, 400, { error: "missing user id" });
    const body = await readJson<{ access?: unknown; status?: string }>(req);
    if (body?.access !== undefined) await updateUserAccess(id, sanitizeAccess(body.access));
    if (body?.status === "ACTIVE" || body?.status === "SUSPENDED") await setUserStatus(id, body.status);
    return json(res, 200, { ok: true });
  }

  // Chart candles — proxied from the TradingBackend's operator-key history endpoint.
  if (path === "/api/chart/history" && req.method === "GET") {
    if (!requireUser(req)) return json(res, 401, { error: "unauthorized" });
    const symbol = url.searchParams.get("symbol") ?? "";
    const resolution = url.searchParams.get("resolution") ?? "300";
    const count = url.searchParams.get("count") ?? "300";
    try {
      const headers: Record<string, string> = {};
      if (config.serviceToken) headers["x-service-token"] = config.serviceToken;
      const upstream = await fetch(
        `${config.tradingApiUrl}/api/market/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&count=${count}`,
        { headers },
      );
      const data = await upstream.json().catch(() => []);
      return json(res, upstream.ok ? 200 : 502, data);
    } catch {
      return json(res, 502, { error: "chart history unavailable (is the trading backend running?)" });
    }
  }

  json(res, 404, { error: "not found" });
}
