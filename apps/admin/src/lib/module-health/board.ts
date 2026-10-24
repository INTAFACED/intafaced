import type { ModuleId } from '@intafaced/config';
import { formatDuration } from '@/lib/ops-desk/model';
import { readSpecFor } from '@/lib/ops-desk/catalog';
import type { OpsDeskId, ReadData, ReadOutcome, ReadSpec } from '@/lib/ops-desk/types';

/**
 * The module health board (`/health`, OPS-ORD-01, ORD-002): one row per platform module with its volume, its failures and
 * the oldest item still waiting, each figure from that module's own operator read and labelled with exactly what it counts.
 *
 * A module with no such read wired here says "no source" and why (`ops.health_source_unwired`), with no count. A module whose
 * read fails refuses its own row (`ops.health_source_unavailable`) and every other row still shows. A figure a read does not
 * give is "not given" with the reason, never a zero. Nothing is cached, summed across modules or estimated.
 */

export const HEALTH_SOURCE_UNWIRED = 'ops.health_source_unwired';
export const HEALTH_SOURCE_UNAVAILABLE = 'ops.health_source_unavailable';

/** One figure: the value as text (counts are summed as whole numbers, never floats), or null with the reason. */
export interface Figure {
  readonly value: string | null;
  readonly note: string;
}

type Read = (id: string) => ReadData;

interface Sourced {
  readonly kind: 'sourced';
  readonly reads: readonly ReadSpec[];
  readonly volume: (read: Read) => Figure;
  readonly failures: (read: Read) => Figure;
  readonly oldest: (read: Read) => Figure;
}

interface Unwired {
  readonly kind: 'unwired';
  readonly blocker: string;
}

export interface HealthRowSpec {
  readonly module: ModuleId;
  readonly label: string;
  /** The console page where the module's own reads and controls are. */
  readonly desk: { readonly href: string; readonly label: string } | null;
  readonly source: Sourced | Unwired;
}

export type HealthRow =
  | {
      readonly module: ModuleId;
      readonly label: string;
      readonly desk: HealthRowSpec['desk'];
      readonly state: 'unwired';
      readonly blocker: string;
    }
  | {
      readonly module: ModuleId;
      readonly label: string;
      readonly desk: HealthRowSpec['desk'];
      readonly state: 'refused';
      readonly service: string;
      readonly message: string;
      readonly asOf: string | null;
    }
  | {
      readonly module: ModuleId;
      readonly label: string;
      readonly desk: HealthRowSpec['desk'];
      readonly state: 'read';
      readonly volume: Figure;
      readonly failures: Figure;
      readonly oldest: Figure;
      readonly asOf: string;
    };

// ─── Reading figures out of a read ─────────────────────────────────────────────────────────────────────────────────

/** A whole count: an int, or a decimal string of digits (some services send counts as text). Anything else is unknown. */
function parseCount(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function count(data: ReadData, key: string): bigint | null {
  return data.shape === 'record' ? parseCount(data.cells.find((c) => c.key === key)?.value) : null;
}

/** Sum of counts, or null if ANY is unknown: a total with a part missing is not given, never shown as complete. */
function sum(values: readonly (bigint | null)[]): bigint | null {
  return values.some((v) => v === null) ? null : (values as bigint[]).reduce((a, b) => a + b, 0n);
}

/** Sum of one column over a list's rows (an empty list is a real zero); null if any row's value is unknown. */
function listSum(data: ReadData, key: string): { total: bigint | null; pageFull: boolean } {
  if (data.shape !== 'list') return { total: null, pageFull: false };
  return { total: sum(data.rows.map((row) => parseCount(row.cells.find((c) => c.key === key)?.value))), pageFull: data.pageFull };
}

const fig = (value: bigint | null, note: string, missing: string): Figure =>
  value === null ? { value: null, note: missing } : { value: value.toString(), note };

const notGiven = (note: string): Figure => ({ value: null, note });

const spec = (desk: OpsDeskId, id: string): ReadSpec => {
  const found = readSpecFor(desk, id);
  if (!found) throw new Error(`module health: desk ${desk} has no read ${id}`);
  return found;
};

// ─── The rows ───────────────────────────────────────────────────────────────────────────────────────────────────────

const unwired = (module: ModuleId, label: string, desk: HealthRowSpec['desk'], blocker?: string): HealthRowSpec => ({
  module,
  label,
  desk,
  source: {
    kind: 'unwired',
    blocker:
      blocker ??
      'No operator read of this module’s volume, failures and oldest waiting item is wired to this board yet, so no count is shown.',
  },
});

const PAY_HEALTH = ['pay.standing-24h', 'pay.oneoff-24h', 'pay.bills-24h'] as const;

export const HEALTH_ROWS: readonly HealthRowSpec[] = [
  unwired('identity', 'Identity', { href: '/accounts', label: 'Account controls' }),
  unwired('ledger', 'Ledger', { href: '/ledger', label: 'Ledger ops' }),
  unwired('token', 'Token', { href: '/more-ops', label: 'More modules' }),
  unwired('matching', 'Matching engine', { href: '/trade-ops', label: 'Trade desk' }),
  unwired('trade', 'Trade', { href: '/trade-ops', label: 'Trade desk' }),
  unwired('execution', 'Execution', null),
  unwired('ws', 'Live feeds', null),
  unwired('pay', 'Merchant pay', { href: '/merchants', label: 'Merchants' }),
  {
    module: 'p2p',
    label: 'P2P',
    desk: { href: '/p2p-ops', label: 'P2P ops' },
    source: {
      kind: 'sourced',
      reads: [spec('p2p', 'p2p.counts'), spec('p2p', 'p2p.backlog')],
      volume: (read) =>
        fig(
          sum(
            ['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed'].map((s) => count(read('p2p.counts'), `trades.${s}`)),
          ),
          'trades, all time',
          'svc-p2p gave no trade counts',
        ),
      failures: (read) =>
        fig(count(read('p2p.counts'), 'trades.disputed'), 'trades that went to dispute, all time', 'svc-p2p gave no dispute count'),
      oldest: (read) => {
        const open = count(read('p2p.backlog'), 'open');
        const overdue = count(read('p2p.backlog'), 'overdue');
        return notGiven(
          `svc-p2p gives no age for its oldest open dispute${open === null ? '' : `; ${open} open now${overdue === null ? '' : `, ${overdue} overdue`}`}`,
        );
      },
    },
  },
  unwired('blueprint', 'Blueprint', null),
  {
    module: 'bank',
    label: 'Bank: personal transfers',
    desk: { href: '/pay-ops', label: 'Personal Pay ops' },
    source: {
      kind: 'sourced',
      reads: PAY_HEALTH.map((id) => spec('pay', id)),
      volume: (read) =>
        fig(
          sum([
            count(read('pay.standing-24h'), 'standingOrders.total'),
            count(read('pay.oneoff-24h'), 'oneOff.total'),
            count(read('pay.bills-24h'), 'bills.total'),
          ]),
          'standing orders, one-off sends and bill payments in the last 24 hours',
          'svc-bank gave no transfer counts for the last 24 hours',
        ),
      failures: (read) =>
        fig(
          sum([
            count(read('pay.standing-24h'), 'standingOrders.rejected'),
            count(read('pay.bills-24h'), 'bills.failed'),
            count(read('pay.bills-24h'), 'bills.returned'),
          ]),
          'rejected standing orders and failed or returned bills, last 24 hours (one-off sends record no failure)',
          'svc-bank gave no failure counts for the last 24 hours',
        ),
      oldest: (read) => {
        const ages = [
          count(read('pay.standing-24h'), 'standingOrders.oldestPendingAgeSeconds'),
          count(read('pay.oneoff-24h'), 'oneOff.oldestPendingAgeSeconds'),
          count(read('pay.bills-24h'), 'bills.oldestPendingAgeSeconds'),
        ].filter((v): v is bigint => v !== null);
        // svc-bank gives a null age when nothing created in the window is still pending, so a null is "none", not "unknown".
        if (ages.length === 0) return notGiven('nothing created in the last 24 hours is still pending');
        const oldest = ages.reduce((a, b) => (a > b ? a : b));
        return { value: formatDuration(Number(oldest)), note: 'oldest transfer still pending, of those created in the last 24 hours' };
      },
    },
  },
  unwired('launch', 'Launch', { href: '/more-ops', label: 'More modules' }),
  unwired('academy', 'Academy', { href: '/academy-ops', label: 'Academy ops' }),
  {
    module: 'market',
    label: 'Market',
    desk: { href: '/more-ops', label: 'More modules' },
    source: {
      kind: 'sourced',
      reads: [spec('more', 'market.sales'), spec('more', 'market.sales-counts')],
      volume: (read) => {
        const { total, pageFull } = listSum(read('market.sales'), 'settledCount');
        return fig(
          total,
          pageFull
            ? 'settled purchases in the last 30 days, at least (the first page of vendors)'
            : 'settled purchases in the last 30 days',
          'svc-market gave no settled count',
        );
      },
      failures: (read) =>
        fig(
          count(read('market.sales-counts'), 'refusedCount'),
          'refused purchases in the last 30 days',
          'svc-market gave no refused count',
        ),
      oldest: (read) => {
        const pending = count(read('market.sales-counts'), 'pendingCount');
        return notGiven(`svc-market gives no age for its oldest pending purchase${pending === null ? '' : `; ${pending} pending now`}`);
      },
    },
  },
  {
    module: 'mining-pool',
    label: 'Mining pool',
    desk: { href: '/more-ops/mining', label: 'Mining desk' },
    source: {
      kind: 'sourced',
      reads: [spec('more', 'mining.shares')],
      volume: (read) => {
        const accepted = listSum(read('mining.shares'), 'acceptedCount');
        const rejected = listSum(read('mining.shares'), 'rejectedCount');
        const total = accepted.total === null || rejected.total === null ? null : accepted.total + rejected.total;
        return fig(total, 'shares submitted, every window', 'svc-mining-pool gave no share counts');
      },
      failures: (read) =>
        fig(
          listSum(read('mining.shares'), 'rejectedCount').total,
          'shares refused, every window, where the miner could be identified (others are not counted)',
          'svc-mining-pool gave no refused count',
        ),
      oldest: () => notGiven('svc-mining-pool gives no age for a waiting item; its payout windows are on the Mining desk'),
    },
  },
  unwired('agents', 'Agents', { href: '/more-ops', label: 'More modules' }),
  unwired('core-ops', 'Operations', null),
  unwired('notify', 'Notifications', { href: '/notify', label: 'Notify health' }),
  unwired('support', 'Support', { href: '/support', label: 'Support queue' }),
  unwired('tax', 'Tax', null),
  unwired('quant', 'Quant', { href: '/more-ops', label: 'More modules' }),
  unwired('campaigns', 'Campaigns', { href: '/more-ops', label: 'More modules' }),
  unwired('edge', 'Edge', { href: '/', label: 'Module board' }),
  unwired('chain', 'Chain', { href: '/protocol-ops', label: 'Protocol ops' }),
  unwired('indexer', 'Indexer', { href: '/protocol-ops', label: 'Protocol ops' }),
  unwired('bridge', 'Bridge', null, 'No bridge service runs on this deployment, so there is nothing to read.'),
  unwired('protocol', 'Protocol', { href: '/protocol-ops', label: 'Protocol ops' }),
  unwired('dex', 'DEX', { href: '/protocol-ops', label: 'Protocol ops' }),
];

/** Every read the board makes, once each. */
export function boardReads(rows: readonly HealthRowSpec[] = HEALTH_ROWS): ReadSpec[] {
  const seen = new Map<string, ReadSpec>();
  for (const row of rows) if (row.source.kind === 'sourced') for (const r of row.source.reads) seen.set(r.id, r);
  return [...seen.values()];
}

const SERVICE_OF: Partial<Record<ReadSpec['module'], string>> = {
  bank: 'svc-bank',
  p2p: 'svc-p2p',
  market: 'svc-market',
  mining: 'svc-mining-pool',
};

/** The board from what was read. A row's failed read refuses that row only. */
export function buildBoard(outcomes: Readonly<Record<string, ReadOutcome>>, rows: readonly HealthRowSpec[] = HEALTH_ROWS): HealthRow[] {
  return rows.map((row): HealthRow => {
    const base = { module: row.module, label: row.label, desk: row.desk };
    if (row.source.kind === 'unwired') return { ...base, state: 'unwired', blocker: row.source.blocker };
    const results = row.source.reads.map((r) => ({ spec: r, outcome: outcomes[r.id] }));
    const missing = results.find((r) => r.outcome === undefined);
    if (missing) {
      return {
        ...base,
        state: 'refused',
        service: SERVICE_OF[missing.spec.module] ?? missing.spec.module,
        message: 'This part was not read.',
        asOf: null,
      };
    }
    const failed = results.find((r) => r.outcome!.part.kind === 'failed');
    if (failed && failed.outcome!.part.kind === 'failed') {
      return {
        ...base,
        state: 'refused',
        service: SERVICE_OF[failed.spec.module] ?? failed.spec.module,
        message: failed.outcome!.part.message,
        asOf: failed.outcome!.asOf,
      };
    }
    const read: Read = (id) => {
      const part = outcomes[id]!.part;
      if (part.kind !== 'ok') throw new Error(`module health: ${id} is not ok`);
      return part.data;
    };
    const asOf = results.map((r) => r.outcome!.asOf).sort()[0]!;
    return {
      ...base,
      state: 'read',
      volume: row.source.volume(read),
      failures: row.source.failures(read),
      oldest: row.source.oldest(read),
      asOf,
    };
  });
}
