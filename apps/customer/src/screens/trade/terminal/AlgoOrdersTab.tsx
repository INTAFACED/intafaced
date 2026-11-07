/**
 * Algo orders: every schedule the service lists for the person (`algo.list`, each re-read with `algo.get` and
 * `algo.progress`), and under each one the child orders it placed, with their state on the book. Progress is the share of
 * the schedule's size that has filled. Pausing, cloning and new schedules stay in the Execution room.
 */
import { Badge, EmptyState, Table, fmtAmount, fmtPrice, type Loadable, type TableColumn } from '../rooms/ui';
import { compareDecimals, percentOf } from '../rooms/math';
import type { Order } from '../../../features/trade/trade-api';
import type { ParentRead } from '../execution/data';
import { Gate } from '../execution/parts';
import { terminalCopy } from './copy';

type Ok = Extract<ParentRead, { ok: true }>;
type Row =
  | { kind: 'parent'; id: string; read: Ok; pct: string | null }
  | {
      kind: 'child';
      id: string;
      orderId: string;
      index: number;
      qty: string | null;
      price: string | null;
      order: Order | null;
      symbol: string;
      side: 'buy' | 'sell';
    }
  | { kind: 'unread'; id: string; ref: string };

const KIND_WORD = { twap: 'Kind twap', vwap: 'Kind vwap', pov: 'Kind pov', chase: 'Kind chase' } as const;
const STATUS_WORD = {
  active: 'Algo active',
  paused: 'Algo paused',
  halted: 'Algo halted',
  completed: 'Algo completed',
  cancelled: 'Algo cancelled',
} as const;
const TONE = { active: 'lime', paused: 'warn', halted: 'error', completed: 'neutral', cancelled: 'neutral' } as const;

function pctOf(read: Ok): string | null {
  const pct = percentOf(read.progress?.filledQty ?? null, read.parent.totalQty, 0);
  return pct !== null && compareDecimals(pct, '100') === 1 ? '100' : pct;
}

/** Parent rows, each followed by its children; a schedule that could not be read stays as one line that says so. */
export function algoRows(parents: readonly ParentRead[], orders: readonly Order[]): Row[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  return parents.flatMap((p): Row[] => {
    if (!p.ok) return [{ kind: 'unread', id: `unread:${p.id}`, ref: p.id }];
    const parent: Row = { kind: 'parent', id: `parent:${p.id}`, read: p, pct: pctOf(p) };
    const children: Row[] = (p.parent.children ?? []).map((c) => {
      const order = byId.get(c.orderId) ?? null;
      return {
        kind: 'child',
        id: `child:${c.orderId}`,
        orderId: c.orderId,
        index: c.sliceIndex,
        qty: c.qty ?? order?.amount ?? null,
        price: c.price ?? order?.price ?? null,
        order,
        symbol: p.parent.symbol,
        side: p.parent.side,
      };
    });
    return [parent, ...children];
  });
}

function orderWord(
  order: Order | null,
): 'Row open' | 'Row partial' | 'Row filled' | 'Row cancelled' | 'Row expired' | 'Row rejected' | null {
  if (!order) return null;
  if (order.status === 'open') return compareDecimals(order.filled, '0') === 1 ? 'Row partial' : 'Row open';
  return order.status === 'closed'
    ? 'Row filled'
    : order.status === 'canceled'
      ? 'Row cancelled'
      : order.status === 'expired'
        ? 'Row expired'
        : 'Row rejected';
}

export function AlgoOrdersTab({ parents, orders }: { parents: Loadable<ParentRead[]>; orders: readonly Order[] }) {
  const { t } = terminalCopy.useCopy();
  const columns: TableColumn<Row>[] = [
    {
      id: 'order',
      header: t('Order'),
      pin: 'start',
      cell: (r) =>
        r.kind === 'parent' ? (
          <span className="font-mono text-xs">{r.read.parent.id}</span>
        ) : r.kind === 'child' ? (
          <span className="ps-4 font-mono text-xs text-fg-2">
            {t('Slice {n}', { n: String(r.index + 1) })} · {r.orderId}
          </span>
        ) : (
          <span className="text-sm text-warn">{t('Algo unreadable {id}', { id: r.ref })}</span>
        ),
    },
    {
      id: 'kind',
      header: t('Kind'),
      cell: (r) => (r.kind === 'parent' ? t(KIND_WORD[r.read.parent.kind]) : null),
    },
    { id: 'market', header: t('Market'), cell: (r) => (r.kind === 'parent' ? r.read.parent.symbol : r.kind === 'child' ? r.symbol : null) },
    {
      id: 'side',
      header: t('Side'),
      cell: (r) => {
        const side = r.kind === 'parent' ? r.read.parent.side : r.kind === 'child' ? r.side : null;
        return side === null ? null : side === 'buy' ? t('Buy') : t('Sell');
      },
    },
    {
      id: 'size',
      header: t('Size'),
      numeric: true,
      cell: (r) =>
        r.kind === 'parent' ? fmtAmount(r.read.parent.totalQty) : r.kind === 'child' && r.qty !== null ? fmtAmount(r.qty) : null,
    },
    {
      id: 'price',
      header: t('Price'),
      numeric: true,
      cell: (r) => {
        const price = r.kind === 'parent' ? r.read.parent.limitPrice : r.kind === 'child' ? r.price : null;
        return price === null ? null : fmtPrice(price, null);
      },
    },
    {
      id: 'progress',
      header: t('Progress'),
      numeric: true,
      cell: (r) => (r.kind === 'parent' && r.pct !== null ? `${r.pct}%` : null),
    },
    {
      id: 'state',
      header: t('State'),
      cell: (r) => {
        if (r.kind === 'parent') return <Badge tone={TONE[r.read.parent.status]}>{t(STATUS_WORD[r.read.parent.status])}</Badge>;
        if (r.kind !== 'child') return null;
        const word = orderWord(r.order);
        return word ? <Badge variant="outline">{t(word)}</Badge> : <span className="text-xs text-fg-2">{t('Not on the book')}</span>;
      },
    },
  ];
  return (
    <Gate load={parents}>
      {(list) => (
        <Table
          label={t('Algo orders')}
          density="dense"
          columns={columns}
          rows={algoRows(list, orders)}
          minWidth={960}
          getRowId={(r) => r.id}
          emptyState={
            <EmptyState
              variant="empty"
              size="inline"
              title={t('No algo orders')}
              reason={t('No algo orders reason')}
              action={{ label: t('Open Execution'), href: '/execution', variant: 'secondary' }}
            />
          }
        />
      )}
    </Gate>
  );
}
