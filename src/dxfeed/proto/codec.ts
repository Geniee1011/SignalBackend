import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import protobuf from "protobufjs";

/* dxFeed Admin Trading API codec (Protobuf over WebSocket).
 *
 * The wire framing is the simplest possible: ONE protobuf message == ONE
 * WebSocket binary frame, with NO length prefix (confirmed from dxFeed's C#
 * example — it just serializes ClientRequestMsg to bytes and sends the frame).
 * So encode → ws.send(bytes, {binary:true}); on a binary frame → decode.
 *
 * We load the shipped .proto at runtime with protobufjs (keepCase so field names
 * match the .proto / C# exactly: LoginReq, AccNumber, ContractId, …). The two
 * .proto files are copied into dist by the postbuild step so this resolves in
 * production as well as under tsx. */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_FILE = join(HERE, "PropTradingProtocol.proto");

let rootPromise: Promise<protobuf.Root> | null = null;

function root(): Promise<protobuf.Root> {
  if (!rootPromise) {
    const r = new protobuf.Root();
    // keepCase: true → JS property names stay PascalCase, matching the .proto.
    rootPromise = r.load(PROTO_FILE, { keepCase: true });
  }
  return rootPromise;
}

async function type(name: string): Promise<protobuf.Type> {
  return (await root()).lookupType(`PropTradingProtocol.${name}`);
}

const DECODE_OPTS: protobuf.IConversionOptions = {
  longs: Number, enums: Number, defaults: false, arrays: true, objects: true, oneofs: true,
};

/** Encode the ONE message a client may send. Throws on a malformed payload. */
export async function encodeClientRequest(payload: Record<string, unknown>): Promise<Uint8Array> {
  const T = await type("ClientRequestMsg");
  const err = T.verify(payload);
  if (err) throw new Error(`dxFeed encode ClientRequestMsg: ${err}`);
  return T.encode(T.create(payload)).finish();
}

/** Decode a server frame into a plain object (oneofs + arrays populated). */
export async function decodeServerResponse(bytes: Uint8Array): Promise<Record<string, any>> {
  const T = await type("ServerResponseMsg");
  return T.toObject(T.decode(bytes), DECODE_OPTS);
}

// --- inverse helpers, for tests and a mock server -------------------------

export async function encodeServerResponse(payload: Record<string, unknown>): Promise<Uint8Array> {
  const T = await type("ServerResponseMsg");
  const err = T.verify(payload);
  if (err) throw new Error(`dxFeed encode ServerResponseMsg: ${err}`);
  return T.encode(T.create(payload)).finish();
}

export async function decodeClientRequest(bytes: Uint8Array): Promise<Record<string, any>> {
  const T = await type("ClientRequestMsg");
  return T.toObject(T.decode(bytes), DECODE_OPTS);
}

/** Eagerly parse the schema (fail fast at startup rather than on first order). */
export async function loadSchema(): Promise<void> {
  await root();
}

// Enums we reference by name in the adapter/client (values are the .proto ints).
export const OrderType = { Market: 0, Limit: 1, Stop: 2, StopLimit: 3 } as const;
export const InfoMode = { Account: 1, OrdAndPos: 2, Positions: 3 } as const;
export const AccountSubscriptionMode = { Undefined: 0, Manual: 1, Existing: 2, ExistingAndNew: 3 } as const;
export const PriceMode = { Ticks: 0, Price: 1, PriceOffset: 2 } as const;
/** Order source, for dxFeed's analysis/diagnostics. We are a copy-trading tool. */
export const RequestSource = { Unknown: 0, Manual: 1, Automatic: 2, Copy: 3 } as const;
export const BracketType = { STOP_AND_TARGET: 0, STOP: 2, TARGET: 4 } as const;
export const CancelFlatAction = { FLAT: 0, CANCEL: 1, FLAT_CANCEL: 2 } as const;
/** OrderInfoMsg.OrderState. `Error` means the order is no longer pending and
 *  carries the broker's `Reason` — it must NOT be read as a placement. */
export const OrderState = {
  Submitted: 0, Canceled: 1, Error: 2, ErrorModify: 3,
  PendingRequest: 100, PendingModify: 101, PendingCancel: 102,
} as const;
/** OrderInfoMsg.SnapType. Only `RealTime` describes something happening NOW;
 *  the others replay prior state on login. */
export const SnapType = { Historical: 1, RealTime: 2, HistPos: 3 } as const;