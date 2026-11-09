/**
 * IFM crash window (PX-S03 / PTX-M03-R09).
 * Crash after in_flight journal, before apply → in_flight_unknown.
 * No second rest. No duplicate fill. Replay must not invent a cancel.
 * FileJournal encode includes the IFM flag (persistInFlight).
 * Hitch: imported from index.ts so MatchingEngine.recover is wrapped without recutting engine.ts.
 */
import { MatchingEngine } from './engine.js';
import {
  IN_FLIGHT_UNKNOWN,
  inFlightAmendResult,
  inFlightCancelResult,
  inFlightSubmitResult,
  persistInFlight,
  replayInFlight,
  type InFlightMark,
} from './ifm.js';
import type { AmendResult, CancelReason, CancelResult, EngineAmend, EngineOrder, MarketId, OrderId, SubmitResult } from './types.js';

const FLAG = Symbol.for('intafaced.matching.ifm-crash');
const STORE = Symbol.for('intafaced.matching.ifm-crash.unknown');

type JournalRow = {
  readonly kind: string;
  readonly marketId?: MarketId;
  readonly orderId?: OrderId;
  readonly mutation?: 'amend' | 'cancel';
  readonly qty?: string | null;
  readonly inFlight?: unknown;
};

type Host = {
  [STORE]?: Map<OrderId, InFlightMark>;
  submit: (marketId: MarketId, order: EngineOrder, proof?: unknown) => Promise<SubmitResult>;
  amend: (marketId: MarketId, cmd: EngineAmend, proof?: unknown) => Promise<AmendResult>;
  cancel: (marketId: MarketId, orderId: OrderId, reason?: CancelReason) => Promise<CancelResult>;
  recover: () => Promise<{ records: number; markets: number }>;
  journal?: { read?: () => readonly JournalRow[] };
};

function asHost(engine: MatchingEngine): Host {
  return engine as unknown as Host;
}

function storeOf(engine: MatchingEngine): Map<OrderId, InFlightMark> {
  const host = asHost(engine);
  if (!host[STORE]) host[STORE] = new Map();
  return host[STORE];
}

function hydrateFromJournal(engine: MatchingEngine): void {
  const records = asHost(engine).journal?.read?.();
  if (!Array.isArray(records)) return;
  const store = storeOf(engine);
  store.clear();
  for (const [orderId, mark] of replayInFlight(records)) {
    const evidence = records.find((record) => record?.kind === 'in_flight' && record.orderId === orderId && persistInFlight(record));
    if (evidence === undefined) continue;
    store.set(orderId, mark);
  }
}

function isCrashUnknown(engine: MatchingEngine, orderId: OrderId): boolean {
  return storeOf(engine).has(orderId);
}

export { IN_FLIGHT_UNKNOWN, persistInFlight, replayInFlight };

export function installIfmCrash(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as unknown as {
    submit: Host['submit'];
    amend: Host['amend'];
    cancel: Host['cancel'];
    recover: Host['recover'];
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origSubmit = proto.submit;
  const origAmend = proto.amend;
  const origCancel = proto.cancel;
  const origRecover = proto.recover;

  proto.recover = async function (this: MatchingEngine) {
    const result = await origRecover.call(this);
    hydrateFromJournal(this);
    return result;
  };

  proto.submit = async function (this: MatchingEngine, marketId: MarketId, order: EngineOrder, proof?: unknown) {
    if (isCrashUnknown(this, order.orderId)) return inFlightSubmitResult(order.orderId, true);
    return origSubmit.call(this, marketId, order, proof);
  };

  proto.amend = async function (this: MatchingEngine, marketId: MarketId, cmd: EngineAmend, proof?: unknown) {
    if (isCrashUnknown(this, cmd.orderId)) return inFlightAmendResult(cmd.orderId, true);
    return origAmend.call(this, marketId, cmd, proof);
  };

  // The reason rides through: an expiry sweep's cancel must leave as `expired`, not the default `requested`.
  proto.cancel = async function (this: MatchingEngine, marketId: MarketId, orderId: OrderId, reason?: CancelReason) {
    if (isCrashUnknown(this, orderId)) return inFlightCancelResult(orderId, true);
    return origCancel.call(this, marketId, orderId, reason);
  };
}

try {
  installIfmCrash();
} catch {
  queueMicrotask(() => installIfmCrash());
}
