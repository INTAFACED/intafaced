import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';

/**
 * The market data lake (RC-algo-dev-02; J-algo-dev-16 #2). A capture pass reads the exchange's own public market data
 * from svc-trade's public routes, the ones any chart reads (`/api/v1/ticker`, `/api/v1/orderbook`, `/api/v1/trades`),
 * normalises it into the lake's record shapes (`@intafaced/connect-data-lake` `MeasuredTick`, `MeasuredBook`,
 * `MeasuredFill`: decimal strings, the capture time and the source's own time) and stores it, with one pass row per
 * symbol and kind. A read that fails, or a symbol an operator paused, stores no row and leaves the pass missing, so the
 * catalogue shows that time as a gap: coverage is read from what was captured, never inferred. The fills are the
 * exchange's anonymised taker prints; no account's own order or fill is ever read here. Holds no balance.
 */

export const LAKE_KINDS = ['tick', 'book', 'fill'] as const;
export type LakeKind = (typeof LAKE_KINDS)[number];

export interface LakeRow {
  readonly sourceKey: string;
  readonly kind: LakeKind;
  readonly symbol: string;
  readonly observedAt: string;
  readonly payload: Record<string, unknown>;
}

export interface LakePass {
  readonly symbol: string;
  readonly kind: LakeKind;
  readonly at: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

export interface CaptureChange {
  readonly id: string;
  readonly symbol: string;
  readonly capturing: boolean;
  readonly reason: string;
  readonly actor: string;
  readonly key: string;
  readonly at: string;
}

export interface LakeStore {
  write(rows: readonly LakeRow[], passes: readonly LakePass[]): Promise<void>;
  passes(symbol: string, kind: LakeKind, sinceIso: string): Promise<readonly LakePass[]>;
  /** Row count, first and last observation of one symbol and kind. */
  extent(symbol: string, kind: LakeKind): Promise<{ count: number; first: string | null; last: string | null }>;
  latest(symbol: string, kind: LakeKind, limit: number): Promise<readonly LakeRow[]>;
  /** The newest fill's source time for one symbol, the cursor the next pass reads from. */
  lastFillMs(symbol: string): Promise<number | null>;
  /** Removes rows and passes older than the cutoff; idempotent on its cutoff. */
  purge(cutoffIso: string): Promise<void>;
  change(input: Omit<CaptureChange, 'id'>): Promise<CaptureChange>;
  changes(symbol: string, limit: number): Promise<readonly CaptureChange[]>;
}

export interface LakeSettings {
  /** QUANT_LAKE_SYMBOLS: the symbols the lake captures. Empty: the lake has no store configured. */
  readonly symbols: readonly string[];
  /** QUANT_LAKE_CAPTURE_SECONDS: seconds between passes. Null: no capture runs. */
  readonly captureSeconds: number | null;
  /** QUANT_LAKE_RETENTION_DAYS: days a captured row is kept. Null: not set. */
  readonly retentionDays: number | null;
}

const price = z.string().regex(/^\d+(\.\d{1,18})?$/);
const tickerBody = z
  .object({ symbol: z.string(), bid: price.nullable(), ask: price.nullable(), last: price.nullable().optional() })
  .passthrough();
const bookBody = z.object({
  bids: z.array(z.tuple([price, price])),
  asks: z.array(z.tuple([price, price])),
  nonce: z.number().int().nullable().optional(),
});
const tradesBody = z.array(z.object({ id: z.string(), timestamp: z.number().int(), side: z.enum(['buy', 'sell']), price, amount: price }));

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const TRADES_PER_PASS = 500;
const BOOK_DEPTH = 10;

/** One capture pass over every configured symbol not paused. What could not be read is a missing pass, never a row. */
export async function capturePass(input: {
  readonly tradeUrl: string;
  readonly settings: LakeSettings;
  readonly store: LakeStore;
  readonly now: () => number;
  readonly fetch?: Fetch;
}): Promise<{ rows: number; holes: number }> {
  const base = input.tradeUrl.replace(/\/+$/, '');
  const fetchImpl: Fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (res.status !== 200) throw new Error(`answered ${res.status}`);
    return res.json();
  };
  const at = new Date(input.now()).toISOString();
  const rows: LakeRow[] = [];
  const passes: LakePass[] = [];
  let holes = 0;
  for (const symbol of input.settings.symbols) {
    const [latestChange] = await input.store.changes(symbol, 1);
    if (latestChange && !latestChange.capturing) continue; // paused: no pass, so the time reads as a gap
    const s = encodeURIComponent(symbol);
    const hole = (kind: LakeKind, reason: string) => {
      holes += 1;
      passes.push({ symbol, kind, at, ok: false, reason: reason.slice(0, 200) });
    };
    try {
      const t = tickerBody.parse(await get(`/api/v1/ticker/${s}`));
      rows.push({
        sourceKey: `tick:${symbol}:${at}`,
        kind: 'tick',
        symbol,
        observedAt: at,
        payload: { status: 'measured', kind: 'tick', marketId: symbol, capturedAt: at, bid: t.bid, ask: t.ask, last: t.last ?? null },
      });
      passes.push({ symbol, kind: 'tick', at, ok: true, reason: null });
    } catch (err) {
      hole('tick', `the ticker read failed: ${(err as Error).message}`);
    }
    try {
      const b = bookBody.parse(await get(`/api/v1/orderbook/${s}?limit=${BOOK_DEPTH}`));
      rows.push({
        sourceKey: `book:${symbol}:${at}`,
        kind: 'book',
        symbol,
        observedAt: at,
        payload: {
          status: 'measured',
          kind: 'book',
          marketId: symbol,
          capturedAt: at,
          occupancy: b.bids.length === 0 && b.asks.length === 0 ? 'empty' : 'populated',
          sequence: b.nonce ?? null,
          bids: b.bids,
          asks: b.asks,
        },
      });
      passes.push({ symbol, kind: 'book', at, ok: true, reason: null });
    } catch (err) {
      hole('book', `the order book read failed: ${(err as Error).message}`);
    }
    try {
      const since = await input.store.lastFillMs(symbol);
      const fromMs = since ?? input.now() - input.settings.captureSeconds! * 1000;
      const prints = tradesBody.parse(await get(`/api/v1/trades/${s}?limit=${TRADES_PER_PASS}&since=${fromMs}`));
      for (const p of prints) {
        rows.push({
          sourceKey: `fill:${symbol}:${p.id}`,
          kind: 'fill',
          symbol,
          observedAt: new Date(p.timestamp).toISOString(),
          payload: {
            status: 'measured',
            kind: 'fill',
            marketId: symbol,
            capturedAt: at,
            ts: new Date(p.timestamp).toISOString(),
            side: p.side,
            price: p.price,
            quantity: p.amount,
          },
        });
      }
      passes.push({ symbol, kind: 'fill', at, ok: true, reason: null });
    } catch (err) {
      hole('fill', `the trades read failed: ${(err as Error).message}`);
    }
  }
  await input.store.write(rows, passes);
  if (input.settings.retentionDays !== null) {
    await input.store.purge(new Date(input.now() - input.settings.retentionDays * 86_400_000).toISOString());
  }
  return { rows: rows.length, holes };
}

export interface CoverageRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Coverage from the stored passes: consecutive ok passes no further apart than twice the capture interval make one
 * range; anything longer between them, or a failed pass, is a hole. One pass alone covers its own instant.
 */
export function coverageOf(passes: readonly LakePass[], captureSeconds: number): { ranges: CoverageRange[]; holes: CoverageRange[] } {
  const ok = passes
    .filter((p) => p.ok)
    .map((p) => Date.parse(p.at))
    .sort((a, b) => a - b);
  const ranges: CoverageRange[] = [];
  const holes: CoverageRange[] = [];
  const limit = 2 * captureSeconds * 1000;
  let start: number | null = null;
  let prev: number | null = null;
  for (const t of ok) {
    if (prev !== null && t - prev > limit) {
      ranges.push({ from: new Date(start!).toISOString(), to: new Date(prev).toISOString() });
      holes.push({ from: new Date(prev).toISOString(), to: new Date(t).toISOString() });
      start = t;
    }
    if (start === null) start = t;
    prev = t;
  }
  if (start !== null && prev !== null) ranges.push({ from: new Date(start).toISOString(), to: new Date(prev).toISOString() });
  return { ranges, holes };
}

export function createMemoryLakeStore(): LakeStore {
  const rows = new Map<string, LakeRow>();
  const passes: LakePass[] = [];
  const changes: CaptureChange[] = [];
  const of = (symbol: string, kind: LakeKind) => [...rows.values()].filter((r) => r.symbol === symbol && r.kind === kind);
  return {
    async write(newRows, newPasses) {
      for (const r of newRows) if (!rows.has(r.sourceKey)) rows.set(r.sourceKey, r);
      passes.push(...newPasses);
    },
    async passes(symbol, kind, sinceIso) {
      return passes.filter((p) => p.symbol === symbol && p.kind === kind && p.at >= sinceIso);
    },
    async extent(symbol, kind) {
      const list = of(symbol, kind)
        .map((r) => r.observedAt)
        .sort();
      return { count: list.length, first: list[0] ?? null, last: list.at(-1) ?? null };
    },
    async latest(symbol, kind, limit) {
      return of(symbol, kind)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        .slice(0, limit);
    },
    async lastFillMs(symbol) {
      const last = of(symbol, 'fill')
        .map((r) => Date.parse(r.observedAt))
        .sort((a, b) => b - a)[0];
      return last ?? null;
    },
    async purge(cutoffIso) {
      for (const [k, r] of rows) if (r.observedAt < cutoffIso) rows.delete(k);
      for (let i = passes.length - 1; i >= 0; i -= 1) if (passes[i]!.at < cutoffIso) passes.splice(i, 1);
    },
    async change(input) {
      const prior = changes.find((c) => c.key === input.key);
      if (prior) return prior;
      const row = { ...input, id: randomUUID() };
      changes.push(row);
      return row;
    },
    async changes(symbol, limit) {
      return changes
        .filter((c) => c.symbol === symbol)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit);
    },
  };
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

export function createPostgresLakeStore(sql: Sql): LakeStore {
  return {
    async write(rows, passes) {
      await sql.begin(async (tx) => {
        for (const r of rows) {
          await tx`INSERT INTO quant.lake_rows (source_key, kind, symbol, observed_at, payload)
            VALUES (${r.sourceKey}, ${r.kind}, ${r.symbol}, ${r.observedAt}, ${tx.json(r.payload as never)})
            ON CONFLICT (source_key) DO NOTHING`;
        }
        for (const p of passes) {
          await tx`INSERT INTO quant.lake_passes (symbol, kind, at, ok, reason) VALUES (${p.symbol}, ${p.kind}, ${p.at}, ${p.ok}, ${p.reason})
            ON CONFLICT DO NOTHING`;
        }
      });
    },
    async passes(symbol, kind, sinceIso) {
      const rows = await sql<{ at: Date; ok: boolean; reason: string | null }[]>`
        SELECT at, ok, reason FROM quant.lake_passes WHERE symbol = ${symbol} AND kind = ${kind} AND at >= ${sinceIso} ORDER BY at`;
      return rows.map((r) => ({ symbol, kind, at: iso(r.at), ok: r.ok, reason: r.reason }));
    },
    async extent(symbol, kind) {
      const [row] = await sql<{ count: string; first: Date | null; last: Date | null }[]>`
        SELECT count(*)::text AS count, min(observed_at) AS first, max(observed_at) AS last
        FROM quant.lake_rows WHERE symbol = ${symbol} AND kind = ${kind}`;
      return { count: Number(row?.count ?? 0), first: row?.first ? iso(row.first) : null, last: row?.last ? iso(row.last) : null };
    },
    async latest(symbol, kind, limit) {
      const rows = await sql<{ source_key: string; observed_at: Date; payload: Record<string, unknown> }[]>`
        SELECT source_key, observed_at, payload FROM quant.lake_rows WHERE symbol = ${symbol} AND kind = ${kind}
        ORDER BY observed_at DESC, source_key DESC LIMIT ${limit}`;
      return rows.map((r) => ({ sourceKey: r.source_key, kind, symbol, observedAt: iso(r.observed_at), payload: r.payload }));
    },
    async lastFillMs(symbol) {
      const [row] = await sql<{ last: Date | null }[]>`
        SELECT max(observed_at) AS last FROM quant.lake_rows WHERE symbol = ${symbol} AND kind = 'fill'`;
      return row?.last ? new Date(row.last).getTime() : null;
    },
    async purge(cutoffIso) {
      await sql`DELETE FROM quant.lake_rows WHERE observed_at < ${cutoffIso}`;
      await sql`DELETE FROM quant.lake_passes WHERE at < ${cutoffIso}`;
    },
    async change(input) {
      const [row] = await sql<{ id: string; at: Date }[]>`
        INSERT INTO quant.lake_capture_changes (id, symbol, capturing, reason, actor, write_key, at)
        VALUES (${randomUUID()}, ${input.symbol}, ${input.capturing}, ${input.reason}, ${input.actor}, ${input.key}, ${input.at})
        ON CONFLICT (write_key) DO NOTHING RETURNING id, at`;
      if (row) return { ...input, id: row.id, at: iso(row.at) };
      const [kept] = await sql<
        { id: string; symbol: string; capturing: boolean; reason: string; actor: string; write_key: string; at: Date }[]
      >`
        SELECT * FROM quant.lake_capture_changes WHERE write_key = ${input.key}`;
      return {
        id: kept!.id,
        symbol: kept!.symbol,
        capturing: kept!.capturing,
        reason: kept!.reason,
        actor: kept!.actor,
        key: kept!.write_key,
        at: iso(kept!.at),
      };
    },
    async changes(symbol, limit) {
      const rows = await sql<
        { id: string; symbol: string; capturing: boolean; reason: string; actor: string; write_key: string; at: Date }[]
      >`
        SELECT * FROM quant.lake_capture_changes WHERE symbol = ${symbol} ORDER BY at DESC LIMIT ${limit}`;
      return rows.map((r) => ({
        id: r.id,
        symbol: r.symbol,
        capturing: r.capturing,
        reason: r.reason,
        actor: r.actor,
        key: r.write_key,
        at: iso(r.at),
      }));
    },
  };
}
