/**
 * The copy, bots and OTC room's data (CB-ops-05, CB-ops-04): the shapes svc-trade's `admin.copyBotsOtc` reads answer,
 * and strict parsers. A body that is not this shape parses to null, so the room shows a refusal rather than a guess.
 * Plain data, safe in server and browser code.
 */

/** A count, or null with the code that says why it could not be read. Never 0 for a failed read. */
export interface OpsMetric {
  readonly value: number | null;
  readonly unavailable: string | null;
}
export interface OpsMetrics {
  readonly asOf: string;
  readonly window: { readonly seconds: number; readonly from: string; readonly to: string };
  readonly activeCopiers: OpsMetric;
  readonly activeBots: OpsMetric;
  readonly rfqsRequested: OpsMetric;
  readonly rfqsSettled: OpsMetric;
}
export interface LookupFollow {
  readonly followId: string;
  readonly leader: string;
  readonly state: string;
  readonly startedAt: string;
}
export interface LookupBot {
  readonly botId: string;
  readonly kind: string;
  readonly symbol: string;
  readonly side: string;
  readonly status: string;
  readonly createdAt: string;
}
export interface DeskQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly lifecycle: string;
  readonly side: string;
  readonly pair: string;
  readonly qty: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
}
export interface CustomerLookup {
  readonly userId: string;
  readonly readAt: string;
  readonly follows: readonly LookupFollow[];
  readonly bots: readonly LookupBot[];
  readonly quotes: readonly DeskQuote[];
}
export interface SettlementException {
  readonly quoteId: string;
  readonly userId: string;
  readonly sagaKey: string;
  readonly reason: string;
  readonly acceptedAt: string;
  readonly deadline: string;
}
export interface QuoteDesk {
  readonly asOf: string;
  readonly quotes: readonly DeskQuote[];
  readonly exceptions: readonly SettlementException[];
}

/** The code svc-trade answers when the caller lacks the lookup scope. */
export const LOOKUP_DENIED_CODE = 'scope.denied';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function all<T>(raw: unknown, one: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = one(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseMetric(raw: unknown): OpsMetric | null {
  const o = obj(raw);
  if (!o || !strOrNull(o.unavailable)) return null;
  if (o.value === null) return o.unavailable === null ? null : { value: null, unavailable: o.unavailable };
  if (typeof o.value !== 'number' || !Number.isSafeInteger(o.value) || o.value < 0) return null;
  return { value: o.value, unavailable: o.unavailable };
}

export function parseOpsMetrics(raw: unknown): OpsMetrics | null {
  const o = obj(raw);
  const w = obj(o?.window);
  if (!o || !w || !str(o.asOf) || typeof w.seconds !== 'number' || !str(w.from) || !str(w.to)) return null;
  const activeCopiers = parseMetric(o.activeCopiers);
  const activeBots = parseMetric(o.activeBots);
  const rfqsRequested = parseMetric(o.rfqsRequested);
  const rfqsSettled = parseMetric(o.rfqsSettled);
  if (!activeCopiers || !activeBots || !rfqsRequested || !rfqsSettled) return null;
  return { asOf: o.asOf, window: { seconds: w.seconds, from: w.from, to: w.to }, activeCopiers, activeBots, rfqsRequested, rfqsSettled };
}

function parseQuote(raw: unknown): DeskQuote | null {
  const o = obj(raw);
  if (!o) return null;
  const { quoteId, userId, lifecycle, side, pair, qty, createdAt, settledAt } = o;
  if (!str(quoteId) || !str(userId) || !str(lifecycle) || !str(side) || !str(pair) || !str(qty) || !str(createdAt) || !strOrNull(settledAt))
    return null;
  return { quoteId, userId, lifecycle, side, pair, qty, createdAt, settledAt };
}

export function parseCustomerLookup(raw: unknown): CustomerLookup | null {
  const o = obj(raw);
  if (!o || !str(o.userId) || !str(o.readAt)) return null;
  const follows = all(o.follows, (v) => {
    const f = obj(v);
    return f && str(f.followId) && str(f.leader) && str(f.state) && str(f.startedAt)
      ? { followId: f.followId, leader: f.leader, state: f.state, startedAt: f.startedAt }
      : null;
  });
  const bots = all(o.bots, (v) => {
    const b = obj(v);
    return b && str(b.botId) && str(b.kind) && str(b.symbol) && str(b.side) && str(b.status) && str(b.createdAt)
      ? { botId: b.botId, kind: b.kind, symbol: b.symbol, side: b.side, status: b.status, createdAt: b.createdAt }
      : null;
  });
  const quotes = all(o.quotes, parseQuote);
  if (!follows || !bots || !quotes) return null;
  return { userId: o.userId, readAt: o.readAt, follows, bots, quotes };
}

export function parseQuoteDesk(raw: unknown): QuoteDesk | null {
  const o = obj(raw);
  if (!o || !str(o.asOf)) return null;
  const quotes = all(o.quotes, parseQuote);
  const exceptions = all(o.exceptions, (v) => {
    const e = obj(v);
    return e && str(e.quoteId) && str(e.userId) && str(e.sagaKey) && str(e.reason) && str(e.acceptedAt) && str(e.deadline)
      ? { quoteId: e.quoteId, userId: e.userId, sagaKey: e.sagaKey, reason: e.reason, acceptedAt: e.acceptedAt, deadline: e.deadline }
      : null;
  });
  if (!quotes || !exceptions) return null;
  return { asOf: o.asOf, quotes, exceptions };
}

/** The first account of identity's exact-email search answer (`id: null` when none matched), or null: not that shape. */
export function parseFirstAccountId(raw: unknown): { readonly id: string | null } | null {
  const rows = obj(raw)?.rows;
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) return { id: null };
  const id = obj(rows[0])?.id;
  return str(id) ? { id } : null;
}

/** A window in whole seconds, in words: "24 hours", "90 minutes", "45 seconds". */
export function windowText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} ${seconds === 86_400 ? 'day' : 'days'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ${seconds === 3_600 ? 'hour' : 'hours'}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** A count for the screen: the number, or "Could not load" when its source failed. Never 0 in place of a failure. */
export function metricText(metric: OpsMetric | null): string {
  return metric?.value == null ? 'Could not load' : String(metric.value);
}
