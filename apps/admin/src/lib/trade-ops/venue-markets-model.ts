/**
 * The venue markets desk (J-cex-spot-16), the pure half: what svc-trade `admin.venueMarkets.list` answers, and the checks
 * the console runs before it files a request, each with svc-trade's own refusal code. Client-safe (no network, no hash).
 *
 * Every figure is a decimal string exactly as the service sent it: no amount is ever held in a JS number here. Where the
 * venue reports no state or no largest order the read is `null` and the desk says "not reported", never a guess.
 */

export const VENUE_ROUTING_STATES = ['show', 'close_only', 'stop'] as const;
export type VenueRoutingState = (typeof VENUE_ROUTING_STATES)[number];
export const VENUE_CHANGES = ['listing', 'routing', 'limits', 'delisting'] as const;
export type VenueChange = (typeof VENUE_CHANGES)[number];

export const ROUTING_LABEL: Readonly<Record<VenueRoutingState, string>> = {
  show: 'Show (routing new orders)',
  close_only: 'Close only (reduce-only orders)',
  stop: 'Stop routing (no new orders)',
};
export const CHANGE_LABEL: Readonly<Record<VenueChange, string>> = {
  listing: 'List the market (opening time)',
  routing: 'Routing state',
  limits: 'Our largest routed order',
  delisting: 'Schedule a delisting',
};
export const VENUE_STATUS_LABEL: Readonly<Record<string, string>> = {
  trading: 'Trading',
  halted: 'Halted',
  cancel_only: 'Cancel only',
  delisted: 'Delisted',
};
export const venueStatusText = (status: string | null): string =>
  status === null ? 'Not reported by the venue' : (VENUE_STATUS_LABEL[status] ?? status);

export interface VenueListingRow {
  readonly version: number;
  readonly change: string;
  readonly opensAt: string;
  readonly delistsAt: string | null;
  readonly routing: VenueRoutingState;
  readonly approvalId: string;
  readonly proposerId: string;
  readonly approverId: string;
  readonly executorId: string;
  readonly reason: string;
  readonly recordedAt: string;
}
export interface VenueCurrentListing extends VenueListingRow {
  readonly open: boolean;
  readonly delisted: boolean;
}
export interface VenueLimitRow {
  readonly version: number;
  readonly maxOrderQty: string;
  readonly maxOrderNotional: string;
  readonly venueMaxOrderQtyAtWrite: string;
  readonly venueMaxOrderNotionalAtWrite: string;
  readonly approvalId: string;
  readonly proposerId: string;
  readonly approverId: string;
  readonly executorId: string;
  readonly reason: string;
  readonly recordedAt: string;
}
export interface VenueMarketRow {
  readonly symbol: string;
  readonly kind: string | null;
  readonly baseAsset: string | null;
  readonly quoteAsset: string | null;
  /** The venue's own word, beside ours. */
  readonly venue: {
    readonly listed: boolean;
    readonly status: string | null;
    readonly maxOrderQty: string | null;
    readonly maxOrderNotional: string | null;
  };
  readonly listing: VenueCurrentListing | null;
  readonly listingHistory: readonly VenueListingRow[];
  readonly limits: VenueLimitRow | null;
  readonly limitHistory: readonly VenueLimitRow[];
  readonly delistingNotice: { readonly noticeKey: string; readonly delistsAt: string; readonly publishedAt: string | null } | null;
}
export interface VenueMarketsView {
  readonly venueId: string;
  readonly test: boolean;
  readonly asOf: string;
  readonly markets: readonly VenueMarketRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRouting = (v: unknown): v is VenueRoutingState => str(v) && (VENUE_ROUTING_STATES as readonly string[]).includes(v);

function listingRow(raw: unknown): VenueListingRow | null {
  if (!isRecord(raw)) return null;
  const { version, change, opensAt, delistsAt, routing, approvalId, proposerId, approverId, executorId, reason, recordedAt } = raw;
  if (!whole(version) || !str(change) || !str(opensAt) || !strOrNull(delistsAt) || !isRouting(routing)) return null;
  if (!str(approvalId) || !str(proposerId) || !str(approverId) || !str(executorId) || !str(reason) || !str(recordedAt)) return null;
  return { version, change, opensAt, delistsAt, routing, approvalId, proposerId, approverId, executorId, reason, recordedAt };
}

function limitRow(raw: unknown): VenueLimitRow | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  if (!whole(r.version)) return null;
  const keys = [
    'maxOrderQty',
    'maxOrderNotional',
    'venueMaxOrderQtyAtWrite',
    'venueMaxOrderNotionalAtWrite',
    'approvalId',
    'proposerId',
    'approverId',
    'executorId',
    'reason',
    'recordedAt',
  ] as const;
  for (const k of keys) if (!str(r[k])) return null;
  return {
    version: r.version,
    maxOrderQty: r.maxOrderQty as string,
    maxOrderNotional: r.maxOrderNotional as string,
    venueMaxOrderQtyAtWrite: r.venueMaxOrderQtyAtWrite as string,
    venueMaxOrderNotionalAtWrite: r.venueMaxOrderNotionalAtWrite as string,
    approvalId: r.approvalId as string,
    proposerId: r.proposerId as string,
    approverId: r.approverId as string,
    executorId: r.executorId as string,
    reason: r.reason as string,
    recordedAt: r.recordedAt as string,
  };
}

function marketRow(raw: unknown): VenueMarketRow | null {
  if (!isRecord(raw) || !str(raw.symbol)) return null;
  if (!strOrNull(raw.kind) || !strOrNull(raw.baseAsset) || !strOrNull(raw.quoteAsset)) return null;
  const v = raw.venue;
  if (!isRecord(v) || typeof v.listed !== 'boolean' || !strOrNull(v.status) || !strOrNull(v.maxOrderQty) || !strOrNull(v.maxOrderNotional))
    return null;
  let listing: VenueCurrentListing | null = null;
  if (raw.listing !== null) {
    const row = listingRow(raw.listing);
    const l = raw.listing as Record<string, unknown>;
    if (!row || typeof l.open !== 'boolean' || typeof l.delisted !== 'boolean') return null;
    listing = { ...row, open: l.open, delisted: l.delisted };
  }
  if (!Array.isArray(raw.listingHistory) || !Array.isArray(raw.limitHistory)) return null;
  const listingHistory = raw.listingHistory.map(listingRow);
  const limitHistory = raw.limitHistory.map(limitRow);
  if (listingHistory.some((r) => r === null) || limitHistory.some((r) => r === null)) return null;
  const limits = raw.limits === null ? null : limitRow(raw.limits);
  if (raw.limits !== null && limits === null) return null;
  let delistingNotice: VenueMarketRow['delistingNotice'] = null;
  if (raw.delistingNotice !== null) {
    const n = raw.delistingNotice;
    if (!isRecord(n) || !str(n.noticeKey) || !str(n.delistsAt) || !strOrNull(n.publishedAt)) return null;
    delistingNotice = { noticeKey: n.noticeKey, delistsAt: n.delistsAt, publishedAt: n.publishedAt };
  }
  return {
    symbol: raw.symbol,
    kind: raw.kind,
    baseAsset: raw.baseAsset,
    quoteAsset: raw.quoteAsset,
    venue: { listed: v.listed, status: v.status, maxOrderQty: v.maxOrderQty, maxOrderNotional: v.maxOrderNotional },
    listing,
    listingHistory: listingHistory as VenueListingRow[],
    limits,
    limitHistory: limitHistory as VenueLimitRow[],
    delistingNotice,
  };
}

/** The wire shape of `admin.venueMarkets.list`. Null when it is not that shape. */
export function parseVenueMarketsView(raw: unknown): VenueMarketsView | null {
  if (!isRecord(raw) || !str(raw.venueId) || typeof raw.test !== 'boolean' || !str(raw.asOf) || !Array.isArray(raw.markets)) return null;
  if (raw.test && raw.label !== 'TEST') return null;
  const markets = raw.markets.map(marketRow);
  if (markets.some((m) => m === null)) return null;
  return { venueId: raw.venueId, test: raw.test, asOf: raw.asOf, markets: markets as VenueMarketRow[] };
}

// ── What the console checks before it files a request (svc-trade checks it all again) ──

export type Check<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };
const no = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });

/**
 * A time as the canonical ISO string svc-trade binds (services/svc-trade/src/admin/venue-markets.ts, the same rule), or null when it is not a real time: ISO with its zone, and every
 * field in range (no 2026-02-30, no 24:00, no +25:00), so a time never silently rolls over into another day.
 */
export function strictVenueTime(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== 'Z' && (Number(m[9]) > 23 || Number(m[10]) > 59)) return null;
  const at = new Date(value.trim());
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** An exact unsigned decimal, as svc-trade takes it. */
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export const REASON_MIN = 12;
export const reasonReady = (reason: string): boolean => reason.trim().length >= REASON_MIN && reason.trim().length <= 500;

function time(value: string, blank: string, invalid: string, label: string): Check<string> {
  const text = value.trim();
  if (text === '') return no(blank, `${label} is blank; it is never filled in.`);
  if (strictVenueTime(text) === null)
    return no(invalid, `${label} must be a time with its zone, such as 2026-11-09T12:00:00Z.`);
  return { ok: true, value: text };
}

export const checkOpensAt = (value: string) =>
  time(value, 'trade.venue_listing_opening_window_blank', 'trade.venue_listing_opening_window_invalid', 'The opening time');
export const checkDelistsAt = (value: string) =>
  time(value, 'trade.venue_delisting_date_blank', 'trade.venue_delisting_date_invalid', 'The delisting date');

export function checkRouting(value: string): Check<VenueRoutingState> {
  return isRouting(value) ? { ok: true, value } : no('trade.venue_routing_invalid', 'Choose show, close only or stop routing.');
}

/** Scaled to 18 places as a bigint, for comparing two exact decimals without a JS number. */
function scaled(text: string): bigint {
  const [w, f = ''] = text.split('.');
  return BigInt(w!) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

function limit(value: string, label: string): Check<string> {
  const text = value.trim();
  if (text === '') return no('trade.venue_limit_blank', `${label} is blank; a limit is never filled in.`);
  if (!DECIMAL.test(text) || scaled(text) <= 0n) return no('trade.venue_limit_not_exact', `${label} must be an exact decimal above zero.`);
  return { ok: true, value: text };
}

/**
 * Our largest routed order, never above the venue's own: a venue that reports none cannot prove it, so nothing is filed
 * (`trade.venue_limit_unknown`), as svc-trade refuses.
 */
export function checkLimits(
  input: { maxOrderQty: string; maxOrderNotional: string },
  venue: { maxOrderQty: string | null; maxOrderNotional: string | null },
): Check<{ maxOrderQty: string; maxOrderNotional: string }> {
  const qty = limit(input.maxOrderQty, 'The largest order size');
  if (!qty.ok) return qty;
  const notional = limit(input.maxOrderNotional, 'The largest order notional');
  if (!notional.ok) return notional;
  if (venue.maxOrderQty === null || venue.maxOrderNotional === null)
    return no(
      'trade.venue_limit_unknown',
      'The venue does not report its largest order on this market, so ours cannot be checked against it.',
    );
  if (scaled(qty.value) > scaled(venue.maxOrderQty) || scaled(notional.value) > scaled(venue.maxOrderNotional))
    return no(
      'trade.venue_limit_above_venue',
      `Our limit would be above the venue's own largest order (${venue.maxOrderQty} size, ${venue.maxOrderNotional} notional).`,
    );
  return { ok: true, value: { maxOrderQty: qty.value, maxOrderNotional: notional.value } };
}

/** Plain words for svc-trade's venue market refusals, shown beside the code. */
export const VENUE_CODE_WORDS: Readonly<Record<string, string>> = {
  'trade.user_venue_off': 'The user-venue door is off on this deployment, so no venue market can be read or changed.',
  'trade.venue_market_unknown': 'The venue does not list this market.',
  'trade.venue_listing_opening_window_blank': 'A listing needs its opening time. Nothing was written.',
  'trade.venue_listing_opening_window_invalid': 'The opening time is not a time, or falls after the delisting date.',
  'trade.venue_listing_stale': 'The market changed since this was proposed. Read the desk again and propose again.',
  'trade.venue_listing_missing': 'This market has no listing yet. List it first.',
  'trade.venue_routing_invalid': 'The routing state is show, close only or stop.',
  'trade.venue_routing_unchanged': 'The market is already in that routing state.',
  'trade.venue_limit_blank': 'A limit is blank. A limit is never filled in.',
  'trade.venue_limit_not_exact': 'A limit must be an exact decimal above zero.',
  'trade.venue_limit_unknown': 'The venue does not report its largest order on this market.',
  'trade.venue_limit_above_venue': "Our limit would be above the venue's own largest order.",
  'trade.venue_limit_stale': 'Our limits changed since this was proposed. Read the desk again and propose again.',
  'trade.venue_delisting_date_blank': 'A delisting needs its date. Nothing was written.',
  'trade.venue_delisting_date_invalid': 'The delisting date is not a time.',
  'trade.venue_delisting_not_future': 'The delisting date must be in the future and after the market opens.',
  'trade.venue_delisting_already_scheduled': 'This market already has a delisting date; one dated notice per market.',
};
