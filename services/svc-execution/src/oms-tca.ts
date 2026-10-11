/**
 * OMS TCA run — PX-S05 §15 read of EMS fills plus named market observations.
 *
 * Fill VWAP comes only from EMS evidence. Arrival/decision/mid/close/interval
 * benchmarks come only from licensed observations or capture records bound by
 * time/checksum. Missing book, mid, fee asset mix, checksum, or license is
 * UNAVAILABLE — never a fabricated VWAP, arrival, or mark. Does not post ledger.
 */
import { createHash } from 'node:crypto';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { CaptureLake, midFromCapture, type CaptureRecord } from '@intafaced/venue-adapter';
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';

export const TCA_METHODOLOGY_VERSION = 'svc-execution.tca.v1' as const;

export const TCA_BENCHMARK_CLASSES = [
  'decision',
  'arrival',
  'interval_vwap',
  'interval_twap',
  'midpoint',
  'close',
  'quoted_spread',
  'client',
] as const;

export type TcaBenchmarkClass = (typeof TCA_BENCHMARK_CLASSES)[number];

export type TcaPrint = {
  readonly price: string;
  readonly amount?: string;
  readonly at?: string;
};

export type TcaObservation = {
  readonly class: TcaBenchmarkClass;
  readonly source: string;
  readonly licensed: boolean;
  readonly venueId?: string;
  readonly price?: string;
  readonly bid?: string;
  readonly ask?: string;
  readonly capturedAt?: string;
  readonly checksum?: string;
  readonly windowFrom?: string;
  readonly windowTo?: string;
  readonly prints?: readonly TcaPrint[];
};

export type TcaEntitlements = {
  readonly licensedSources?: readonly string[];
  readonly licensedClasses?: readonly TcaBenchmarkClass[];
};

export type TcaRunInput = {
  readonly parentClientOrderId?: string;
  readonly clientOrderId?: string;
  readonly executionGroupId?: string;
  readonly account?: string;
  readonly instrument?: string;
  readonly mandateVersion?: string;
  readonly decisionAt?: string;
  readonly arrivalAt?: string;
  readonly venueUniverse?: readonly string[];
  readonly excludedVenues?: readonly string[];
  readonly entitlements?: TcaEntitlements;
  readonly observations?: readonly TcaObservation[];
  readonly emsStore?: EmsOrderStore;
  readonly captureLake?: Pick<CaptureLake, 'records'>;
};

export type TcaGapCode =
  | 'ems_store_unwired'
  | 'missing_identity'
  | 'no_ems_evidence'
  | 'no_fill_evidence'
  | 'unresolved_child'
  | 'rejected_child'
  | 'instrument_mismatch'
  | 'missing_observation'
  | 'unlicensed'
  | 'missing_source'
  | 'missing_checksum'
  | 'missing_fee'
  | 'mixed_fee_asset'
  | 'missing_book'
  | 'one_sided_book'
  | 'capture_hole'
  | 'missing_prints'
  | 'missing_window'
  | 'invalid_amount';

export type TcaGap = { readonly code: TcaGapCode; readonly detail: string };

export type TcaFill = {
  readonly clientOrderId: string;
  readonly childOrderId: string | null;
  readonly venueId: string;
  readonly venueOrderId: string;
  readonly side: 'buy' | 'sell';
  readonly filledAmount: string;
  readonly averagePrice: string;
  readonly feeAmount: string;
  readonly feeAsset: string;
  readonly status: 'filled' | 'partial';
  readonly executedAt: string;
};

export type TcaBenchmarkAvailable = {
  readonly class: TcaBenchmarkClass;
  readonly status: 'AVAILABLE';
  readonly source: string;
  readonly venueId: string | null;
  readonly price: string;
  readonly window: { readonly from: string | null; readonly to: string | null };
  readonly weighting: 'volume' | 'time' | 'none';
  readonly sideSign: 'buy_positive_is_worse' | 'sell_positive_is_worse';
  readonly units: 'price' | 'spread';
  readonly clockQuality: 'caller_observation' | 'capture_lake' | 'interval_prints';
  readonly checksum: string | null;
  readonly confidence: 'bounded';
};

export type TcaBenchmarkUnavailable = {
  readonly class: TcaBenchmarkClass;
  readonly status: 'UNAVAILABLE';
  readonly source: string | null;
  readonly gap: TcaGapCode;
  readonly detail: string;
};

export type TcaBenchmarkResult = TcaBenchmarkAvailable | TcaBenchmarkUnavailable;

export type TcaRealizedAvailable = {
  readonly status: 'AVAILABLE';
  readonly fillVwap: string;
  readonly filledAmount: string;
  readonly feeAmount: string | null;
  readonly feeAsset: string | null;
  readonly feeGap: TcaGap | null;
};

export type TcaRealizedUnavailable = {
  readonly status: 'UNAVAILABLE';
  readonly gap: TcaGapCode;
  readonly detail: string;
};

export type TcaSlippageAvailable = {
  readonly status: 'AVAILABLE';
  readonly versus: TcaBenchmarkClass;
  readonly fillVwap: string;
  readonly benchmark: string;
  readonly slippage: string;
  readonly slippageBps: string;
};

export type TcaSlippageUnavailable = {
  readonly status: 'UNAVAILABLE';
  readonly versus: TcaBenchmarkClass;
  readonly gap: TcaGapCode;
  readonly detail: string;
};

export type TcaRun = {
  readonly methodologyVersion: typeof TCA_METHODOLOGY_VERSION;
  readonly inputDigest: string;
  readonly parentClientOrderId: string | null;
  readonly clientOrderIds: readonly string[];
  readonly executionGroupId: string | null;
  readonly mandateVersion: string | null;
  readonly account: string | null;
  readonly instrument: string | null;
  readonly decisionAt: string | null;
  readonly arrivalAt: string | null;
  readonly executionInterval: { readonly from: string | null; readonly to: string | null };
  readonly venueUniverse: readonly string[];
  readonly excludedVenues: readonly string[];
  readonly entitlements: {
    readonly licensedSources: readonly string[];
    readonly licensedClasses: readonly TcaBenchmarkClass[];
  };
  readonly fills: readonly TcaFill[];
  readonly gaps: readonly TcaGap[];
  readonly completeness: 'complete' | 'partial';
  readonly realized: TcaRealizedAvailable | TcaRealizedUnavailable;
  readonly benchmarks: readonly TcaBenchmarkResult[];
  readonly slippage: readonly (TcaSlippageAvailable | TcaSlippageUnavailable)[];
};

export type TcaRunOk = { readonly ok: true; readonly run: TcaRun };
export type TcaRunRefuse = {
  readonly ok: false;
  readonly reason: 'missing_identity' | 'ems_store_unwired' | 'no_ems_evidence';
  readonly detail: string;
};
export type TcaRunResult = TcaRunOk | TcaRunRefuse;

const BPS = parseAmount('10000');

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDecimal(raw: string | undefined, label: string): Amount | TcaGap {
  if (raw === undefined || raw.trim() === '') {
    return { code: 'invalid_amount', detail: `${label} is missing` };
  }
  try {
    return parseAmount(raw);
  } catch (err) {
    return { code: 'invalid_amount', detail: err instanceof Error ? err.message : `${label} is not a decimal string` };
  }
}

function isGap(value: Amount | TcaGap): value is TcaGap {
  return typeof value === 'object' && value !== null && 'code' in value;
}

type TcaCaptureHit = { readonly mid: Amount; readonly checksum: string; readonly source: string; readonly venueId: string };

function isCaptureGap(value: TcaCaptureHit | TcaGap): value is TcaGap {
  return 'code' in value;
}

function unavailable(cls: TcaBenchmarkClass, gap: TcaGapCode, detail: string, source: string | null = null): TcaBenchmarkUnavailable {
  return { class: cls, status: 'UNAVAILABLE', source, gap, detail };
}

function captureChecksum(record: Extract<CaptureRecord, { kind: 'book' }>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        venueId: record.venueId,
        symbol: record.symbol,
        capturedAt: record.capturedAt.toISOString(),
        sequence: record.snapshot.sequence,
        bids: record.snapshot.bids.map(([p, q]) => [formatAmount(p), formatAmount(q)]),
        asks: record.snapshot.asks.map(([p, q]) => [formatAmount(p), formatAmount(q)]),
      }),
    )
    .digest('hex');
}

function isCaptureSourced(obs: TcaObservation): boolean {
  return obs.source.startsWith('capture.') || Boolean(obs.checksum);
}

function licenseGap(obs: TcaObservation | undefined, entitlements: TcaEntitlements, cls: TcaBenchmarkClass): TcaGap | null {
  if (!obs) return { code: 'missing_observation', detail: `no ${cls} observation` };
  if (!obs.source.trim()) return { code: 'missing_source', detail: `${cls} observation has no source` };
  if (!obs.licensed) return { code: 'unlicensed', detail: `${cls} observation source ${obs.source} is not licensed` };
  const sources = entitlements.licensedSources ?? [];
  if (sources.length > 0 && !sources.includes(obs.source)) {
    return { code: 'unlicensed', detail: `${cls} source ${obs.source} is outside data entitlements` };
  }
  const classes = entitlements.licensedClasses ?? [];
  if (classes.length > 0 && !classes.includes(cls)) {
    return { code: 'unlicensed', detail: `${cls} is not in licensed benchmark classes` };
  }
  if (isCaptureSourced(obs) && !obs.checksum?.trim()) {
    return { code: 'missing_checksum', detail: `${cls} capture observation has no checksum` };
  }
  return null;
}

function vwap(fills: readonly TcaFill[]): Amount | TcaGap {
  let notional: Amount = 0n;
  let qty: Amount = 0n;
  for (const fill of fills) {
    const px = parseDecimal(fill.averagePrice, 'averagePrice');
    const amt = parseDecimal(fill.filledAmount, 'filledAmount');
    if (isGap(px)) return px;
    if (isGap(amt)) return amt;
    if (amt <= 0n) continue;
    if (px <= 0n) continue;
    notional = add(notional, mul(px, amt, 'half-up'));
    qty = add(qty, amt);
  }
  if (qty <= 0n) return { code: 'no_fill_evidence', detail: 'EMS rows have no positive filled amount' };
  return div(notional, qty, 'half-up');
}

function intervalVwap(prints: readonly TcaPrint[]): Amount | TcaGap {
  if (prints.length === 0) return { code: 'missing_prints', detail: 'interval VWAP needs prints with price and amount' };
  let notional: Amount = 0n;
  let qty: Amount = 0n;
  for (const print of prints) {
    const px = parseDecimal(print.price, 'print.price');
    const amt = parseDecimal(print.amount, 'print.amount');
    if (isGap(px)) return px;
    if (isGap(amt)) return { code: 'missing_prints', detail: 'interval VWAP print is missing amount — refusing to invent volume' };
    if (amt <= 0n) continue;
    if (px <= 0n) continue;
    notional = add(notional, mul(px, amt, 'half-up'));
    qty = add(qty, amt);
  }
  if (qty <= 0n) return { code: 'missing_prints', detail: 'interval VWAP prints have no positive amount' };
  return div(notional, qty, 'half-up');
}

function intervalTwap(prints: readonly TcaPrint[], windowFrom: string | undefined, windowTo: string | undefined): Amount | TcaGap {
  if (!windowFrom || !windowTo) return { code: 'missing_window', detail: 'interval TWAP needs windowFrom and windowTo' };
  const fromMs = Date.parse(windowFrom);
  const toMs = Date.parse(windowTo);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { code: 'missing_window', detail: 'interval TWAP window is not a forward time range' };
  }
  if (prints.length === 0) return { code: 'missing_prints', detail: 'interval TWAP needs prints with price and at' };
  const stamped: { px: Amount; at: number }[] = [];
  for (const print of prints) {
    if (!print.at) return { code: 'missing_prints', detail: 'interval TWAP print is missing at — refusing equal-weight substitute' };
    const at = Date.parse(print.at);
    if (!Number.isFinite(at)) return { code: 'missing_prints', detail: 'interval TWAP print at is not a timestamp' };
    const px = parseDecimal(print.price, 'print.price');
    if (isGap(px)) return px;
    stamped.push({ px, at });
  }
  stamped.sort((a, b) => a.at - b.at);
  let weighted: Amount = 0n;
  let duration = 0n;
  for (let i = 0; i < stamped.length; i += 1) {
    const start = Math.max(stamped[i]!.at, fromMs);
    const end = i + 1 < stamped.length ? Math.min(stamped[i + 1]!.at, toMs) : toMs;
    const dt = end - start;
    if (dt <= 0) continue;
    if (stamped[i]!.px <= 0n) continue;
    const dtAmt = parseAmount(String(dt));
    weighted = add(weighted, mul(stamped[i]!.px, dtAmt, 'half-up'));
    duration = add(duration, dtAmt);
  }
  if (duration <= 0n) return { code: 'missing_prints', detail: 'interval TWAP prints do not cover the window' };
  return div(weighted, duration, 'half-up');
}

function midFromBidAsk(bidRaw: string | undefined, askRaw: string | undefined): Amount | TcaGap {
  const bid = parseDecimal(bidRaw, 'bid');
  const ask = parseDecimal(askRaw, 'ask');
  if (isGap(bid)) return { code: 'missing_book', detail: 'midpoint/spread needs bid' };
  if (isGap(ask)) return { code: 'missing_book', detail: 'midpoint/spread needs ask' };
  if (bid <= 0n || ask <= 0n) return { code: 'missing_book', detail: 'bid/ask must be positive' };
  if (bid >= ask) return { code: 'one_sided_book', detail: 'bid/ask is crossed or one-sided — refusing a mid' };
  return div(add(bid, ask), parseAmount('2'), 'half-up');
}

function selectEvidence(store: EmsOrderStore, input: TcaRunInput): readonly EmsOrderEvidence[] {
  const clientOrderId = input.clientOrderId?.trim();
  if (clientOrderId) {
    const row = store.get(clientOrderId);
    return row ? [row] : [];
  }
  const parentClientOrderId = input.parentClientOrderId?.trim();
  if (parentClientOrderId) return store.list({ parentClientOrderId });
  const executionGroupId = input.executionGroupId?.trim();
  if (executionGroupId) return store.list({ executionGroupId });
  return [];
}

function toFill(row: EmsOrderEvidence): TcaFill | TcaGap {
  if (!row.execution || row.execution.status === 'rejected') {
    if (row.state === 'SUBMIT_UNKNOWN' || row.state === 'OUTCOME_UNKNOWN' || row.execution === null) {
      return { code: 'unresolved_child', detail: `EMS child ${row.clientOrderId} has no fill evidence` };
    }
    return { code: 'rejected_child', detail: `EMS child ${row.clientOrderId} was rejected` };
  }
  if (row.execution.status !== 'filled' && row.execution.status !== 'partial') {
    return { code: 'no_fill_evidence', detail: `EMS child ${row.clientOrderId} status is not a fill` };
  }
  return {
    clientOrderId: row.clientOrderId,
    childOrderId: row.childOrderId ?? null,
    venueId: row.execution.venueId,
    venueOrderId: row.execution.venueOrderId,
    side: row.side,
    filledAmount: formatAmount(row.execution.filledAmount),
    averagePrice: formatAmount(row.execution.averagePrice),
    feeAmount: formatAmount(row.execution.feeAmount),
    feeAsset: row.execution.feeAsset,
    status: row.execution.status,
    executedAt: iso(row.execution.executedAt) ?? '',
  };
}

function findObservation(observations: readonly TcaObservation[], cls: TcaBenchmarkClass): TcaObservation | undefined {
  return observations.find((obs) => obs.class === cls);
}

function captureAt(
  lake: Pick<CaptureLake, 'records'> | undefined,
  venueId: string | undefined,
  symbol: string | null,
  at: string | null,
  checksum: string | undefined,
): { mid: Amount; checksum: string; source: string; venueId: string } | TcaGap {
  if (!lake) return { code: 'missing_book', detail: 'no capture lake bound to this TCA run' };
  const records = lake.records();
  if (checksum?.trim()) {
    const match = records.find((row) => row.kind === 'book' && captureChecksum(row) === checksum.trim());
    if (!match || match.kind !== 'book') return { code: 'missing_checksum', detail: 'capture checksum does not match a book record' };
    if (match.kind === 'book') {
      const mid = midFromCapture(match);
      if (mid === null) {
        return match.snapshot.bids.length === 0 || match.snapshot.asks.length === 0
          ? { code: 'one_sided_book', detail: 'capture book has no two-sided mid' }
          : { code: 'missing_book', detail: 'capture book has no mid' };
      }
      return { mid, checksum: checksum.trim(), source: 'capture.lake', venueId: match.venueId };
    }
  }
  if (!at || !venueId || !symbol)
    return { code: 'missing_book', detail: 'capture lookup needs venue, instrument, and arrival/decision time' };
  const hole = records.find(
    (row) => row.kind === 'hole' && row.venueId === venueId && row.symbol === symbol && row.capturedAt.toISOString() === at,
  );
  if (hole && hole.kind === 'hole') {
    return { code: 'capture_hole', detail: `capture hole ${hole.reason}: ${hole.detail}` };
  }
  const book = records.find(
    (row) => row.kind === 'book' && row.venueId === venueId && row.symbol === symbol && row.capturedAt.toISOString() === at,
  );
  if (!book || book.kind !== 'book') return { code: 'missing_book', detail: `no capture book for ${venueId} ${symbol} at ${at}` };
  const mid = midFromCapture(book);
  if (mid === null) {
    return book.snapshot.bids.length === 0 || book.snapshot.asks.length === 0
      ? { code: 'one_sided_book', detail: `capture book for ${venueId} ${symbol} at ${at} has no two-sided mid` }
      : { code: 'missing_book', detail: `capture book for ${venueId} ${symbol} at ${at} has no mid` };
  }
  return { mid, checksum: captureChecksum(book), source: 'capture.lake', venueId: book.venueId };
}

function priceBenchmark(
  cls: TcaBenchmarkClass,
  obs: TcaObservation | undefined,
  entitlements: TcaEntitlements,
  side: 'buy' | 'sell',
  capture: Pick<CaptureLake, 'records'> | undefined,
  venueId: string | undefined,
  instrument: string | null,
  boundAt: string | null,
): TcaBenchmarkResult {
  const classLicense = entitlements.licensedClasses ?? [];
  if (classLicense.length > 0 && !classLicense.includes(cls) && !obs) {
    return unavailable(cls, 'unlicensed', `${cls} is not in licensed benchmark classes`);
  }

  if (obs) {
    const gap = licenseGap(obs, entitlements, cls);
    if (gap) return unavailable(cls, gap.code, gap.detail, obs.source || null);
    if (cls === 'quoted_spread') {
      const bid = parseDecimal(obs.bid, 'bid');
      const ask = parseDecimal(obs.ask, 'ask');
      if (isGap(bid) || isGap(ask)) return unavailable(cls, 'missing_book', 'quoted spread needs bid and ask', obs.source);
      if ((bid as Amount) <= 0n || (ask as Amount) <= 0n) {
        return unavailable(cls, 'missing_book', 'bid/ask must be positive', obs.source);
      }
      const spread = sub(ask as Amount, bid as Amount);
      if (spread <= 0n) return unavailable(cls, 'one_sided_book', 'quoted spread is not positive', obs.source);
      return {
        class: cls,
        status: 'AVAILABLE',
        source: obs.source,
        venueId: obs.venueId ?? null,
        price: formatAmount(spread),
        window: { from: obs.windowFrom ?? iso(obs.capturedAt), to: obs.windowTo ?? iso(obs.capturedAt) },
        weighting: 'none',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'spread',
        clockQuality: isCaptureSourced(obs) ? 'capture_lake' : 'caller_observation',
        checksum: obs.checksum ?? null,
        confidence: 'bounded',
      };
    }
    if (cls === 'interval_vwap') {
      const px = intervalVwap(obs.prints ?? []);
      if (isGap(px)) return unavailable(cls, px.code, px.detail, obs.source);
      return {
        class: cls,
        status: 'AVAILABLE',
        source: obs.source,
        venueId: obs.venueId ?? null,
        price: formatAmount(px),
        window: { from: obs.windowFrom ?? null, to: obs.windowTo ?? null },
        weighting: 'volume',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'price',
        clockQuality: 'interval_prints',
        checksum: obs.checksum ?? null,
        confidence: 'bounded',
      };
    }
    if (cls === 'interval_twap') {
      const px = intervalTwap(obs.prints ?? [], obs.windowFrom, obs.windowTo);
      if (isGap(px)) return unavailable(cls, px.code, px.detail, obs.source);
      return {
        class: cls,
        status: 'AVAILABLE',
        source: obs.source,
        venueId: obs.venueId ?? null,
        price: formatAmount(px),
        window: { from: obs.windowFrom ?? null, to: obs.windowTo ?? null },
        weighting: 'time',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'price',
        clockQuality: 'interval_prints',
        checksum: obs.checksum ?? null,
        confidence: 'bounded',
      };
    }
    if (cls === 'midpoint' && (obs.bid !== undefined || obs.ask !== undefined) && obs.price === undefined) {
      const mid = midFromBidAsk(obs.bid, obs.ask);
      if (isGap(mid)) return unavailable(cls, mid.code, mid.detail, obs.source);
      return {
        class: cls,
        status: 'AVAILABLE',
        source: obs.source,
        venueId: obs.venueId ?? null,
        price: formatAmount(mid),
        window: { from: iso(obs.capturedAt), to: iso(obs.capturedAt) },
        weighting: 'none',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'price',
        clockQuality: isCaptureSourced(obs) ? 'capture_lake' : 'caller_observation',
        checksum: obs.checksum ?? null,
        confidence: 'bounded',
      };
    }
    if (obs.price !== undefined) {
      const px = parseDecimal(obs.price, `${cls}.price`);
      if (isGap(px) || px <= 0n) return unavailable(cls, 'invalid_amount', `${cls} price is missing or not a positive decimal`, obs.source);
      return {
        class: cls,
        status: 'AVAILABLE',
        source: obs.source,
        venueId: obs.venueId ?? null,
        price: formatAmount(px),
        window: { from: obs.windowFrom ?? iso(obs.capturedAt) ?? boundAt, to: obs.windowTo ?? iso(obs.capturedAt) ?? boundAt },
        weighting: 'none',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'price',
        clockQuality: isCaptureSourced(obs) ? 'capture_lake' : 'caller_observation',
        checksum: obs.checksum ?? null,
        confidence: 'bounded',
      };
    }
  }

  if (cls === 'arrival' || cls === 'midpoint' || cls === 'decision') {
    const looked = captureAt(capture, venueId ?? obs?.venueId, instrument, boundAt, obs?.checksum);
    if (!isCaptureGap(looked)) {
      return {
        class: cls,
        status: 'AVAILABLE',
        source: looked.source,
        venueId: looked.venueId,
        price: formatAmount(looked.mid),
        window: { from: boundAt, to: boundAt },
        weighting: 'none',
        sideSign: side === 'buy' ? 'buy_positive_is_worse' : 'sell_positive_is_worse',
        units: 'price',
        clockQuality: 'capture_lake',
        checksum: looked.checksum,
        confidence: 'bounded',
      };
    }
    if (obs) return unavailable(cls, looked.code, looked.detail, obs.source);
    return unavailable(cls, looked.code, looked.detail);
  }

  return unavailable(cls, 'missing_observation', `no ${cls} observation and no bound capture`);
}

function slippageVs(
  versus: TcaBenchmarkClass,
  fillVwap: Amount,
  side: 'buy' | 'sell',
  bench: TcaBenchmarkResult,
): TcaSlippageAvailable | TcaSlippageUnavailable {
  if (bench.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', versus, gap: bench.gap, detail: bench.detail };
  }
  if (bench.units === 'spread') {
    return { status: 'UNAVAILABLE', versus, gap: 'missing_observation', detail: `${versus} is a spread, not a price benchmark` };
  }
  const benchmark = parseAmount(bench.price);
  if (benchmark <= 0n) {
    return { status: 'UNAVAILABLE', versus, gap: 'invalid_amount', detail: `${versus} benchmark is not a positive price` };
  }
  const raw = side === 'buy' ? sub(fillVwap, benchmark) : sub(benchmark, fillVwap);
  const bps = div(mul(raw, BPS, 'half-up'), benchmark, 'half-up');
  return {
    status: 'AVAILABLE',
    versus,
    fillVwap: formatAmount(fillVwap),
    benchmark: bench.price,
    slippage: formatAmount(raw),
    slippageBps: formatAmount(bps),
  };
}

function inputDigest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function runTcaRun(input: TcaRunInput): TcaRunResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() || null;
  const clientOrderId = input.clientOrderId?.trim() || null;
  const executionGroupId = input.executionGroupId?.trim() || null;
  if (!parentClientOrderId && !clientOrderId && !executionGroupId) {
    return { ok: false, reason: 'missing_identity', detail: 'parentClientOrderId, clientOrderId, or executionGroupId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for a TCA run' };
  }

  const rows = selectEvidence(input.emsStore, input);
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_ems_evidence',
      detail: 'no EMS journal rows for the bound order/parent/group — refusing to invent fills',
    };
  }

  const gaps: TcaGap[] = [];
  const fills: TcaFill[] = [];
  for (const row of rows) {
    const mapped = toFill(row);
    if ('code' in mapped) {
      gaps.push(mapped);
      continue;
    }
    fills.push(mapped);
  }

  const instrumentFromEms = rows[0]?.symbol ?? null;
  if (input.instrument?.trim() && instrumentFromEms && input.instrument.trim() !== instrumentFromEms) {
    gaps.push({
      code: 'instrument_mismatch',
      detail: `caller instrument ${input.instrument.trim()} does not match EMS symbol ${instrumentFromEms}`,
    });
  }
  const instrument = instrumentFromEms ?? input.instrument?.trim() ?? null;
  const side = (fills[0]?.side ?? rows[0]?.side ?? 'buy') as 'buy' | 'sell';
  const venues = [...new Set(rows.map((row) => row.venueId))];
  const excludedVenues = [...new Set((input.excludedVenues ?? []).map((v) => v.trim()).filter(Boolean))];
  const venueUniverse = [...new Set([...(input.venueUniverse ?? []), ...venues])].filter((v) => !excludedVenues.includes(v));
  const executedAts = fills
    .map((f) => f.executedAt)
    .filter(Boolean)
    .sort();
  const entitlements: TcaEntitlements = {
    licensedSources: input.entitlements?.licensedSources ?? [],
    licensedClasses: input.entitlements?.licensedClasses ?? [],
  };
  const observations = input.observations ?? [];
  const primaryVenue = fills[0]?.venueId ?? rows[0]?.venueId;

  const realizedPx = fills.length > 0 ? vwap(fills) : { code: 'no_fill_evidence' as const, detail: 'EMS evidence has no fills' };
  let realized: TcaRun['realized'];
  if (isGap(realizedPx)) {
    gaps.push(realizedPx);
    realized = { status: 'UNAVAILABLE', gap: realizedPx.code, detail: realizedPx.detail };
  } else {
    const feeAssets = [...new Set(fills.map((f) => f.feeAsset).filter(Boolean))];
    let feeAmount: string | null = null;
    let feeAsset: string | null = null;
    let feeGap: TcaGap | null = null;
    if (feeAssets.length === 0) {
      feeGap = { code: 'missing_fee', detail: 'fills have no fee asset' };
      gaps.push(feeGap);
    } else if (feeAssets.length > 1) {
      feeGap = { code: 'mixed_fee_asset', detail: `cannot sum fees across assets ${feeAssets.join(',')}` };
      gaps.push(feeGap);
    } else {
      feeAsset = feeAssets[0]!;
      let fee: Amount = 0n;
      for (const fill of fills) fee = add(fee, parseAmount(fill.feeAmount));
      feeAmount = formatAmount(fee);
    }
    realized = {
      status: 'AVAILABLE',
      fillVwap: formatAmount(realizedPx),
      filledAmount: formatAmount(fills.reduce((acc, f) => add(acc, parseAmount(f.filledAmount)), 0n)),
      feeAmount,
      feeAsset,
      feeGap,
    };
  }

  const benchmarks: TcaBenchmarkResult[] = TCA_BENCHMARK_CLASSES.map((cls) =>
    priceBenchmark(
      cls,
      findObservation(observations, cls),
      entitlements,
      side,
      input.captureLake,
      primaryVenue,
      instrument,
      cls === 'decision' ? iso(input.decisionAt) : iso(input.arrivalAt),
    ),
  );

  const slippage: TcaRun['slippage'] = isGap(realizedPx)
    ? TCA_BENCHMARK_CLASSES.map((cls) => ({
        status: 'UNAVAILABLE' as const,
        versus: cls,
        gap: realizedPx.code,
        detail: realizedPx.detail,
      }))
    : benchmarks.map((bench) => slippageVs(bench.class, realizedPx, side, bench));

  for (const bench of benchmarks) {
    if (bench.status === 'UNAVAILABLE') gaps.push({ code: bench.gap, detail: bench.detail });
  }

  const hasArrivalOrDecisionSlippage = slippage.some(
    (row) => row.status === 'AVAILABLE' && (row.versus === 'arrival' || row.versus === 'decision'),
  );
  const completeness: TcaRun['completeness'] =
    realized.status === 'AVAILABLE' && hasArrivalOrDecisionSlippage && !gaps.some((g) => g.code === 'unresolved_child')
      ? 'complete'
      : 'partial';

  const run: TcaRun = {
    methodologyVersion: TCA_METHODOLOGY_VERSION,
    inputDigest: inputDigest({
      methodologyVersion: TCA_METHODOLOGY_VERSION,
      parentClientOrderId,
      clientOrderId,
      executionGroupId,
      account: input.account?.trim() || null,
      instrument,
      mandateVersion: input.mandateVersion?.trim() || null,
      decisionAt: iso(input.decisionAt),
      arrivalAt: iso(input.arrivalAt),
      fills,
      observations,
      entitlements,
      venueUniverse,
      excludedVenues,
    }),
    parentClientOrderId: parentClientOrderId ?? rows[0]?.parentClientOrderId ?? null,
    clientOrderIds: rows.map((row) => row.clientOrderId),
    executionGroupId: executionGroupId ?? rows[0]?.executionGroupId ?? null,
    mandateVersion: input.mandateVersion?.trim() || null,
    account: input.account?.trim() || null,
    instrument,
    decisionAt: iso(input.decisionAt),
    arrivalAt: iso(input.arrivalAt),
    executionInterval: { from: executedAts[0] ?? null, to: executedAts[executedAts.length - 1] ?? null },
    venueUniverse,
    excludedVenues,
    entitlements: {
      licensedSources: entitlements.licensedSources ?? [],
      licensedClasses: entitlements.licensedClasses ?? [],
    },
    fills,
    gaps,
    completeness,
    realized,
    benchmarks,
    slippage,
  };

  return { ok: true, run };
}
