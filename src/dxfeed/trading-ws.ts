import WebSocket from "ws";
import { authenticate } from "./trading-auth.js";
import { encodeClientRequest, decodeServerResponse, OrderState, SnapType } from "./proto/codec.js";
import {
  loginReq, pingReq, accountSnapshotReq, contractReq, symbolLookupReq,
  orderInsert, orderRemove, cancelFlat,
} from "./proto/orders.js";
import type { DxTradingClient, DxEntryOrder } from "./trading-client.js";

/* B4–B8 — the live dxFeed Admin Trading API client (WSS + Protobuf).
 *
 * One long-lived session, authenticated with the fullTrading SYSTEM credential,
 * places orders across every account by accountNumber. Implements DxTradingClient
 * so the copy engine's adapter uses it unchanged.
 *
 * Framing: one protobuf message per binary frame, no prefix. Correlation:
 *   - contracts  → keyed by feed symbol (ContractReq → ContractMsg)
 *   - orders     → keyed by our per-session SeqClientId (→ OrderInfo.OrgServerId)
 *   - accounts   → AccountReferenceId (our dxAccountId UUID) → accountNumber
 * The message dispatch + correlation is written to be unit-testable off a socket. */

const PING_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
/**
 * Ceiling for reconnect backoff.
 *
 * Deliberately minutes, not seconds. Every attempt re-authenticates AND retries
 * the WS upgrade, so a refused connection retried every 30s is a sustained burst
 * against the broker's edge — which is what got these connections answered with a
 * bare HTTP 400 during integration. Early retries are still fast (1s, 2s, 4s…) so
 * an ordinary dropped socket recovers immediately; only a persistent refusal
 * decays to a slow poll.
 */
const MAX_BACKOFF_MS = 5 * 60_000;
const REQ_TIMEOUT_MS = 15_000;
/** The symbol table can arrive across several frames; treat it as complete once
 *  no further frame has landed for this long. */
const SYMBOLS_SETTLE_MS = 750;
/** How often to refetch the symbol table, so a long-lived session follows rolls. */
const SYMBOL_REFRESH_MS = 6 * 60 * 60 * 1000;

interface Pending<T> { resolve: (v: T) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** AccountHeaderMsg.Permission — why an account may refuse orders. */
export const AccountPermission = { Trading: 0, ReadOnly: 1, RiskPause: 2, LiquidateOnly: 3 } as const;
/** AccountHeaderMsg.Status. */
export const AccountState = { INITIALIZED: 0, ENABLED: 1, SUCCESS: 2, FAILED: 4, DISABLED: 8 } as const;

/** The trading-relevant flags on an account, as the session reports them. */
export interface DxAccountInfo {
  accountNumber: number;
  header: string;
  isEnabled: boolean;
  isTradingEnabled: boolean;
  /** AccountPermission — ReadOnly/RiskPause/LiquidateOnly all block a new entry. */
  permission: number;
  status: number;
  isTradeCopierAllowed: boolean;
}

/** A tradable futures contract as the symbol table describes it. */
export interface FrontMonth {
  /** Dated feed symbol, e.g. "/MESU26:XCME". */
  feedSymbol: string;
  contractId: number;
  /** Expiry as YYYYMM (from the description), used to pick the nearest contract. */
  expiry: number;
}

/** "/MESU26:XCME" → "MES". Anchored so an equity like "MESA&Q" can't match: only
 *  the "/ROOT<monthcode><yy>:MIC" shape is a futures contract. */
const FUTURES_RE = /^\/([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{2}):/;

/**
 * What an OrderInfoMsg means for the order we are waiting on. Pure, so the two
 * ways this can go wrong are testable without a socket:
 *
 *  - `ignore`  — a login snapshot replaying PRIOR orders. Those carry
 *    SeqClientIds from earlier sessions while our counter restarts at 1 on every
 *    connect, so acting on them lets an old order satisfy a brand-new one.
 *  - `reject`  — the broker refused it. Resolving here would record a position
 *    that does not exist.
 */
export type OrderOutcome =
  | { kind: "ignore" }
  | { kind: "reject"; reason: string }
  | { kind: "resolve"; serverId: number };

export function orderInfoOutcome(o: Record<string, any>): OrderOutcome {
  const snap = Number(o.SnapType);
  if (Number.isFinite(snap) && snap !== SnapType.RealTime) return { kind: "ignore" };

  const state = Number(o.OrderState);
  if (state === OrderState.Error || state === OrderState.ErrorModify) {
    return { kind: "reject", reason: String(o.Reason || "no reason given") };
  }
  return { kind: "resolve", serverId: Number(o.OrgServerId) };
}

/** Expiry from a description like "MES-202609-CME". */
function expiryOf(description: unknown, symbol: string): number {
  const m = /-(\d{6})-/.exec(String(description ?? ""));
  if (m) return Number(m[1]);
  // Fall back to the symbol's own month code, so a missing description degrades
  // to a worse ordering rather than losing the contract entirely.
  const s = FUTURES_RE.exec(symbol);
  if (!s) return Number.MAX_SAFE_INTEGER;
  return (2000 + Number(s[3])) * 100 + ("FGHJKMNQUVXZ".indexOf(s[2]!) + 1);
}

export class DxFeedTradingClient implements DxTradingClient {
  private ws: WebSocket | null = null;
  private running = false;
  private authed = false;
  private retries = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  /** AccountReferenceId (our dxAccountId UUID) → dxFeed accountNumber. */
  private readonly accountByRef = new Map<string, number>();
  /** Same key → the account's trading flags, for diagnosing refusals. */
  private readonly accountInfo = new Map<string, DxAccountInfo>();
  /** Root ("MES") → nearest-expiry contract, published atomically per refresh. */
  private readonly frontMonth = new Map<string, FrontMonth>();
  /** In-flight table being assembled; swapped into frontMonth once it settles. */
  private incomingSymbols: Map<string, FrontMonth> | null = null;
  private symbolsSettleTimer: NodeJS.Timeout | null = null;
  private symbolRefreshTimer: NodeJS.Timeout | null = null;
  private symbolsReady: Promise<void> | null = null;
  private markSymbolsReady: (() => void) | null = null;
  private symbolsLoadedOnce = false;
  private frameLogger: ((msg: Record<string, any>) => void) | null = null;
  private readonly contractCache = new Map<string, number>();
  private readonly pendingContracts = new Map<string, Pending<number>>();
  private readonly pendingOrders = new Map<number, Pending<number>>();

  private lastLoginReason: string | null = null;

  isConnected(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * The server's own words for the most recent refused LoginReq, or null if we
   * never got that far. Worth surfacing verbatim: the reasons look alike but mean
   * very different things — "Service is not available yet (user)" is a freshly
   * created user that has not propagated into the trading engine, while
   * "Server is currently not available" is the session/capacity limit. Guessing
   * between them from a generic timeout sent us down the wrong diagnosis once.
   */
  loginFailureReason(): string | null {
    return this.lastLoginReason;
  }

  /** dxFeed accountNumber for one of our account UUIDs, if the session knows it. */
  accountNumberForRef(referenceId: string): number | undefined {
    return this.accountByRef.get(referenceId);
  }

  /** Test-only: whether the login handshake has completed (independent of the socket). */
  get authenticated(): boolean { return this.authed; }

  /** Every account this session can trade, as [ourUuid, dxFeedAccountNumber].
   *  Diagnostics only — the order path looks accounts up by reference id. */
  knownAccounts(): Array<[string, number]> {
    return [...this.accountByRef.entries()];
  }

  /** Trading flags for an account, once the snapshot has arrived. */
  accountInfoFor(referenceId: string): DxAccountInfo | undefined {
    return this.accountInfo.get(referenceId);
  }

  /**
   * Why this account would refuse an order, or null if it should accept one.
   * Checked before sending so a refusal is reported as a reason rather than as
   * an unexplained ack timeout.
   */
  blockedReason(referenceId: string): string | null {
    const a = this.accountInfo.get(referenceId);
    if (!a) return "account not in the session snapshot";
    if (!a.isEnabled) return "account is not enabled";
    if (!a.isTradingEnabled) return "trading is disabled on this account";
    if (a.permission === AccountPermission.ReadOnly) return "account is read-only";
    if (a.permission === AccountPermission.RiskPause) return "account is paused by the risk engine";
    if (a.permission === AccountPermission.LiquidateOnly) return "account is liquidate-only";
    if (a.status === AccountState.FAILED) return "account has FAILED its evaluation";
    if (a.status === AccountState.DISABLED) return "account is disabled";
    return null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.authed = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.symbolRefreshTimer) clearInterval(this.symbolRefreshTimer);
    if (this.symbolsSettleTimer) clearTimeout(this.symbolsSettleTimer);
    this.pingTimer = this.reconnectTimer = null;
    this.symbolRefreshTimer = this.symbolsSettleTimer = null;
    for (const p of this.pendingContracts.values()) { clearTimeout(p.timer); p.reject(new Error("client stopped")); }
    for (const p of this.pendingOrders.values()) { clearTimeout(p.timer); p.reject(new Error("client stopped")); }
    this.pendingContracts.clear();
    this.pendingOrders.clear();
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Close and wait for the socket to actually finish closing.
   *
   * stop() only *initiates* the close, so a script that exits straight after it
   * kills the process mid-handshake and the server keeps the session open. That
   * matters because a user is capped at 5 concurrent trading sessions — leaking
   * them a few runs in a row gets the next connection refused with a 400 at the
   * WS upgrade, which looks like a broken credential and isn't.
   */
  async stopAndDrain(timeoutMs = 3_000): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) { this.stop(); return; }
    const closed = new Promise<void>((res) => ws.once("close", () => res()));
    this.stop();
    await Promise.race([closed, new Promise<void>((res) => setTimeout(res, timeoutMs))]);
  }

  // --- connection ----------------------------------------------------------

  private async connect(): Promise<void> {
    this.authed = false;
    let auth;
    try {
      auth = await authenticate();
    } catch (err) {
      console.warn("[dxfeed-trading] auth failed:", (err as Error).message);
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(auth.wssEndpoint);
    this.ws = ws;
    ws.on("open", () => { void this.send(loginReq(auth!.token)); });
    ws.on("message", (data: WebSocket.RawData) => { void this.onFrame(data); });
    ws.on("error", (err) => console.warn("[dxfeed-trading] socket error:", (err as Error).message));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.authed = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.running) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.retries, MAX_BACKOFF_MS);
    this.retries += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /** Returns false when the frame could NOT be sent (socket dropped/handshaking).
   *  Fire-and-forget callers ignore it; the close path must not — see flatten(). */
  private async send(payload: Record<string, unknown>): Promise<boolean> {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    const bytes = await encodeClientRequest(payload);
    this.ws.send(bytes, { binary: true });
    return true;
  }

  /** Diagnostics: see every decoded frame. The client only ACTS on a handful of
   *  message types, so without this a server reply we don't handle is invisible
   *  and looks identical to no reply at all. */
  setFrameLogger(fn: ((msg: Record<string, any>) => void) | null): void {
    this.frameLogger = fn;
  }

  private async onFrame(data: WebSocket.RawData): Promise<void> {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Buffer);
      const msg = await decodeServerResponse(bytes as Uint8Array);
      this.frameLogger?.(msg);
      this.dispatch(msg);
    } catch (err) {
      console.warn("[dxfeed-trading] bad frame:", (err as Error).message);
    }
  }

  // --- dispatch (unit-testable: pass a decoded ServerResponseMsg) -----------

  dispatch(msg: Record<string, any>): void {
    if (msg.LoginMsg) this.onLogin(msg.LoginMsg);
    if (msg.InfoMsg?.AccountList?.length) this.onAccountList(msg.InfoMsg.AccountList);
    if (msg.AccountStatusUpdates?.length) this.onAccountList(msg.AccountStatusUpdates);
    if (msg.SymbolLookup?.Symbols?.length) this.onSymbolLookup(msg.SymbolLookup.Symbols);
    if (msg.ContractMsg) this.onContract(msg.ContractMsg);
    if (msg.OrderInfo?.length) for (const o of msg.OrderInfo) this.onOrderInfo(o);
    if (msg.CancelFlatMsg) this.onCancelFlat(msg.CancelFlatMsg);
    if (msg.LoggedOff) console.warn("[dxfeed-trading] logged off:", msg.LoggedOff.Reason);
  }

  private onLogin(login: { Success?: boolean; Reason?: string }): void {
    if (!login.Success) {
      this.lastLoginReason = login.Reason ?? "no reason given";
      console.warn("[dxfeed-trading] login failed:", login.Reason);
      return;
    }
    this.lastLoginReason = null;
    this.authed = true;
    this.retries = 0;
    if (!this.pingTimer) this.pingTimer = setInterval(() => void this.send(pingReq()), PING_MS);
    void this.send(accountSnapshotReq()); // → account list + snapshots
    this.requestSymbolTable();
    // Refetch periodically, not just at login. This session is long-lived and the
    // table is what names the front month, so without this a process that stays
    // up across a roll keeps sending orders for an expired contract. GC's front
    // month expires within the current month at time of writing, so this is a
    // live concern, not a theoretical one.
    if (!this.symbolRefreshTimer) {
      this.symbolRefreshTimer = setInterval(() => this.requestSymbolTable(), SYMBOL_REFRESH_MS);
    }
    console.log("[dxfeed-trading] logged in — requesting account snapshot + symbol table");
  }

  private requestSymbolTable(): void {
    // Build into a STAGING map. Merging into the live one would be wrong on a
    // refresh: the merge keeps the nearest expiry, so an already-expired contract
    // would always beat its replacement and the roll could never take effect.
    this.incomingSymbols = new Map();
    // Only gate resolveRoot on the FIRST load; later refreshes must not make a
    // working table look unready and stall an order behind a network fetch.
    if (!this.symbolsLoadedOnce) {
      this.symbolsReady = new Promise<void>((res) => { this.markSymbolsReady = res; });
    }
    void this.send(symbolLookupReq());
  }

  /**
   * Accumulate a symbol-table frame, keeping only futures and only the NEAREST
   * expiry per root. The server sends the next contract alongside the front month
   * when a roll is close (seen live on GC/MGC/CL/MCL), so "first one wins" would
   * pick an arbitrary side of the roll depending on frame order.
   */
  private onSymbolLookup(symbols: Array<Record<string, any>>): void {
    const staging = (this.incomingSymbols ??= new Map());
    for (const s of symbols) {
      const symbol = String(s.Symbol ?? "");
      const m = FUTURES_RE.exec(symbol);
      if (!m) continue; // equities/ETFs share the table; they are not tradable here
      const contractId = Number(s.ContractId);
      if (!Number.isFinite(contractId)) continue;

      const root = m[1]!;
      const expiry = expiryOf(s.Description, symbol);
      const held = staging.get(root);
      if (!held || expiry < held.expiry) staging.set(root, { feedSymbol: symbol, contractId, expiry });
    }

    // The response carries no end-of-stream flag, so settle on a quiet interval
    // and publish the staged table as one atomic swap.
    if (this.symbolsSettleTimer) clearTimeout(this.symbolsSettleTimer);
    this.symbolsSettleTimer = setTimeout(() => {
      this.symbolsSettleTimer = null;
      const table = this.incomingSymbols;
      this.incomingSymbols = null;
      if (!table || table.size === 0) return; // keep the previous table over an empty one

      this.frontMonth.clear();
      for (const [root, fm] of table) this.frontMonth.set(root, fm);
      this.symbolsLoadedOnce = true;
      console.log(`[dxfeed-trading] symbol table ready — ${this.frontMonth.size} futures roots`);
      this.markSymbolsReady?.();
      this.markSymbolsReady = null;
    }, SYMBOLS_SETTLE_MS);
  }

  private onAccountList(entries: Array<Record<string, any>>): void {
    for (const e of entries) {
      // AccountStatusUpdateMsg wraps the header in `.Info`; an InfoMsg.AccountList
      // element IS the AccountHeaderMsg itself.
      const h = e.Info ?? e;
      const ref = h.AccountReferenceId as string | undefined;
      const num = Number(h.accountNumber);
      if (!ref || !Number.isFinite(num)) continue;
      this.accountByRef.set(ref, num);
      // Keep the trading flags: an account can be present in the snapshot and
      // still silently refuse orders (ReadOnly, RiskPause, trading disabled), and
      // without these that looks like a timeout with no explanation.
      this.accountInfo.set(ref, {
        accountNumber: num,
        header: String(h.accountHeader ?? ""),
        isEnabled: h.IsEnabled === true,
        isTradingEnabled: h.IsTradingEnabled === true,
        permission: Number(h.Permission ?? 0),
        status: Number(h.Status ?? 0),
        isTradeCopierAllowed: h.IsTradeCopierAllowed === true,
      });
    }
  }

  private onContract(c: { FeedSymbol?: string; ContractId?: number }): void {
    if (!c.FeedSymbol) return;
    const id = Number(c.ContractId);
    if (Number.isFinite(id) && id >= 0) this.contractCache.set(c.FeedSymbol, id);
    const p = this.pendingContracts.get(c.FeedSymbol);
    if (p) {
      clearTimeout(p.timer);
      this.pendingContracts.delete(c.FeedSymbol);
      if (Number.isFinite(id) && id >= 0) p.resolve(id);
      else p.reject(new Error(`contract not found for ${c.FeedSymbol}`));
    }
  }

  /**
   * The response to a flatten. Errors here are logged rather than thrown because
   * the send already returned: this is how a close that the broker refused
   * becomes visible at all, instead of a flatten silently doing nothing. Per the
   * protocol an EMPTY Errors list means everything executed.
   */
  private onCancelFlat(m: Record<string, any>): void {
    const errors: Array<Record<string, any>> = m.Errors ?? [];
    if (errors.length === 0) {
      const items: Array<Record<string, any>> = m.Items ?? [];
      console.log(`[dxfeed-trading] flatten OK on account ${m.AccNumber} (${items.length} item(s) actioned)`);
      return;
    }
    console.warn(
      `[dxfeed-trading] flatten on account ${m.AccNumber} reported ${errors.length} error(s):`,
      errors.map((e) => JSON.stringify(e)).join("; "),
    );
  }

  private onOrderInfo(o: Record<string, any>): void {
    const outcome = orderInfoOutcome(o);
    if (outcome.kind === "ignore") return;

    const seq = Number(o.SeqClientId);
    const p = this.pendingOrders.get(seq);
    if (!p) return;

    clearTimeout(p.timer);
    this.pendingOrders.delete(seq);
    if (outcome.kind === "reject") p.reject(new Error(`dxFeed rejected the order: ${outcome.reason}`));
    else p.resolve(outcome.serverId);
  }

  // --- B6: contract resolution ---------------------------------------------

  /** The front-month contract for a root ("MES"), once the table has arrived. */
  frontMonthFor(root: string): FrontMonth | undefined {
    return this.frontMonth.get(root.toUpperCase());
  }

  /** Every root this session can trade — diagnostics and the B11 probe. */
  tradableRoots(): FrontMonth[] {
    return [...this.frontMonth.values()].sort((a, b) => a.feedSymbol.localeCompare(b.feedSymbol));
  }

  /**
   * Resolve one of OUR roots ("MES") to the contract id to trade right now.
   *
   * This replaces building a dated feed symbol ourselves. Doing that meant
   * knowing each product's roll calendar — the index futures roll quarterly but
   * gold and crude don't, and a wrong guess is not a soft failure: "/MESZ25:XCME"
   * resolved to nothing at all against live staging. The server already knows the
   * front month, so we ask instead of deriving.
   */
  async resolveRoot(root: string): Promise<number> {
    const key = root.toUpperCase();
    const hit = this.frontMonth.get(key);
    if (hit) return hit.contractId;

    // The table may still be in flight on a freshly-opened session.
    if (this.symbolsReady) {
      await Promise.race([
        this.symbolsReady,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`symbol table timeout resolving ${root}`)), REQ_TIMEOUT_MS)),
      ]);
      const late = this.frontMonth.get(key);
      if (late) return late.contractId;
    }
    throw new Error(`${root} is not tradable on this dxFeed session (no front-month contract)`);
  }

  async resolveContract(feedSymbol: string): Promise<number> {
    const cached = this.contractCache.get(feedSymbol);
    if (cached != null) return cached;
    const existing = this.pendingContracts.get(feedSymbol);
    if (existing) return new Promise((res, rej) => { const prev = existing.resolve, prevR = existing.reject; existing.resolve = (v) => { prev(v); res(v); }; existing.reject = (e) => { prevR(e); rej(e); }; });

    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingContracts.delete(feedSymbol); reject(new Error(`contract resolve timeout: ${feedSymbol}`)); }, REQ_TIMEOUT_MS);
      this.pendingContracts.set(feedSymbol, { resolve, reject, timer });
      void this.send(contractReq(feedSymbol));
    });
  }

  // --- B7: place a bracketed entry -----------------------------------------

  async placeEntry(order: DxEntryOrder): Promise<{ brokerOrderId: string }> {
    if (!this.isConnected()) throw new Error("dxFeed trading session not connected");
    const accountNumber = this.accountByRef.get(order.accountId);
    if (accountNumber == null) throw new Error(`no accountNumber known for account ${order.accountId} (not in snapshot yet)`);

    const contractId = await this.resolveRoot(order.symbol);
    const seqClientId = ++this.seq;

    const serverId = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingOrders.delete(seqClientId); reject(new Error("order ack timeout")); }, REQ_TIMEOUT_MS);
      this.pendingOrders.set(seqClientId, { resolve, reject, timer });
      void this.send(orderInsert({
        accountNumber, contractId, seqClientId,
        side: order.side, quantity: order.quantity, limitPrice: order.limitPrice,
        stopLoss: order.stopLoss, takeProfit: order.takeProfit, orderType: order.orderType,
      }));
    });
    return { brokerOrderId: String(serverId) };
  }

  // --- B8: flatten (mirror the trader going flat) --------------------------

  async flatten(accountId: string, symbol: string): Promise<void> {
    if (!this.isConnected()) throw new Error("dxFeed trading session not connected");
    const accountNumber = this.accountByRef.get(accountId);
    if (accountNumber == null) throw new Error(`no accountNumber known for account ${accountId}`);
    const contractId = await this.resolveRoot(symbol);
    // FLAT_CANCEL: cancels a still-resting entry AND flattens any fill, in one shot.
    //
    // send() drops the frame if the socket died between the isConnected() check
    // above and here. THROW on that rather than returning quietly: the caller
    // marks a close as sent on a clean return, and a silently dropped flatten
    // would retire the close while the position is still open.
    if (!(await this.send(cancelFlat(accountNumber, contractId)))) {
      throw new Error("dxFeed trading session dropped before the flatten was sent");
    }
  }

  /** Cancel a specific resting order by its server id (used by the close path). */
  async cancelOrder(accountNumber: number, orgServerId: number): Promise<void> {
    if (!(await this.send(orderRemove(accountNumber, orgServerId)))) {
      throw new Error("dxFeed trading session dropped before the cancel was sent");
    }
  }
}