/**
 * Core TIF hitch (PX-S03 §5.1 / PTX-M04-R01).
 * Hitch missing TIF rather than mapping to GTC. GTD/GTT pass through (expireAt required; no invented EOD).
 * Client-id uniqueness is account/environment domain, not live-order only.
 * Close-position stays IOC flatten. Do not invent expireAt, EOD, or a clientOrderId.
 * Hitch: imported from index.ts so MatchingEngine is wrapped without recutting engine.ts.
 */
import { MatchingEngine } from './engine.js';
import type { EngineOrder, MarketId, RejectReason, SubmitResult, TimeInForce } from './types.js';

export const TIF_MISSING = 'tif_missing' as const;
export const CLIENT_ORDER_ID_REUSE = 'client_order_id_reuse' as const;
export const TIF_MISSING_MESSAGE = 'tif is required; missing TIF is not GTC';
export const CLIENT_ORDER_ID_REUSE_MESSAGE = 'clientOrderId already used in this account/environment domain';

/** Known TIF tokens. Unknown/blank is tif_missing — never a silent GTC map. */
export const KNOWN_TIF = ['GTC', 'IOC', 'FOK', 'PO', 'GTD', 'GTT'] as const satisfies readonly TimeInForce[];

const FLAG = Symbol.for('intafaced.matching.core-tif');
const STORE = Symbol.for('intafaced.matching.core-tif.seen');

type Host = {
  [STORE]?: Set<string>;
  submit: (marketId: MarketId, order: EngineOrder, proof?: unknown) => Promise<SubmitResult>;
  recover: () => Promise<{ records: number; markets: number }>;
  journal?: { read?: () => readonly unknown[] };
};

function asHost(engine: MatchingEngine): Host {
  return engine as unknown as Host;
}

function seenOf(engine: MatchingEngine): Set<string> {
  const host = asHost(engine);
  if (!host[STORE]) host[STORE] = new Set();
  return host[STORE];
}

function readTif(order: EngineOrder): string | null {
  const raw = (order as { tif?: unknown }).tif;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function tifIsMissing(order: EngineOrder): boolean {
  const tif = readTif(order);
  if (tif === null) return true;
  return !(KNOWN_TIF as readonly string[]).includes(tif);
}

export function tifMissingRefuse(): RejectReason {
  return { code: TIF_MISSING, message: TIF_MISSING_MESSAGE };
}

export function tifMissingResult(): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: tifMissingRefuse(),
    cancellations: [],
    triggered: [],
  };
}

function readClientOrderId(order: EngineOrder): string | null {
  const raw = (order as { clientOrderId?: unknown }).clientOrderId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Environment is part of the client-id domain key.
 * Missing environment is empty in the key — not a silent 'live' stamp.
 */
function readEnvironment(order: EngineOrder): string {
  const raw = (order as { environment?: unknown }).environment;
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function domainKey(order: EngineOrder, clientOrderId: string): string {
  return `${order.accountId}\0${readEnvironment(order)}\0${clientOrderId}`;
}

export function clientOrderIdReuseRefuse(): RejectReason {
  return { code: CLIENT_ORDER_ID_REUSE, message: CLIENT_ORDER_ID_REUSE_MESSAGE };
}

export function clientOrderIdReuseResult(): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: clientOrderIdReuseRefuse(),
    cancellations: [],
    triggered: [],
  };
}

function remember(engine: MatchingEngine, order: EngineOrder): void {
  const clientOrderId = readClientOrderId(order);
  if (clientOrderId === null) return;
  seenOf(engine).add(domainKey(order, clientOrderId));
}

function forget(engine: MatchingEngine, order: EngineOrder): void {
  const clientOrderId = readClientOrderId(order);
  if (clientOrderId === null) return;
  seenOf(engine).delete(domainKey(order, clientOrderId));
}

function alreadySeen(engine: MatchingEngine, order: EngineOrder): boolean {
  const clientOrderId = readClientOrderId(order);
  if (clientOrderId === null) return false;
  return seenOf(engine).has(domainKey(order, clientOrderId));
}

function hydrateFromJournal(engine: MatchingEngine): void {
  const records = asHost(engine).journal?.read?.();
  if (!Array.isArray(records)) return;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const row = record as { kind?: unknown; order?: EngineOrder };
    if (row.kind !== 'submit' || row.order == null) continue;
    remember(engine, row.order);
  }
}

export function installCoreTif(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as unknown as {
    submit: (marketId: MarketId, order: EngineOrder, proof?: unknown) => Promise<SubmitResult>;
    recover: () => Promise<{ records: number; markets: number }>;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origSubmit = proto.submit;
  const origRecover = proto.recover;

  proto.submit = async function (this: MatchingEngine, marketId: MarketId, order: EngineOrder, proof?: unknown) {
    if (tifIsMissing(order)) return tifMissingResult();
    if (alreadySeen(this, order)) return clientOrderIdReuseResult();
    // Claim before origSubmit. It accepts onto the book, then yields at emit.
    remember(this, order);
    // A thrown publication may follow a durable fill. Keep the claim when
    // the outcome is unknown; only a returned no-effect refusal releases it.
    const result = await origSubmit.call(this, marketId, order, proof);
    if (!result.accepted && result.fills.length === 0 && result.resting === null && result.triggered.every((row) => row.fills.length === 0))
      forget(this, order);
    return result;
  };

  proto.recover = async function (this: MatchingEngine) {
    const result = await origRecover.call(this);
    hydrateFromJournal(this);
    return result;
  };
}

try {
  installCoreTif();
} catch {
  queueMicrotask(() => installCoreTif());
}
