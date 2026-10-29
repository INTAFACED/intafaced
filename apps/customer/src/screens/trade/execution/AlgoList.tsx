/** The schedules this device knows, each re-read from the service, and the detail of the one picked. */
import { Badge, Button, EmptyState, KeyValue, Table, fmtAmount, fmtPrice, type Loadable, type TableColumn } from '../rooms/ui';
import { Freshness } from '../rooms/RoomNotices';
import { roomWords } from '../rooms/refusals';
import { compareDecimals, percentOf } from '../rooms/math';
import { execCopy } from './copy';
import type { ParentRead } from './data';
import { Gate, Why, useWhen } from './parts';

export type AlgoAction = 'pause' | 'resume' | 'cancel';
type Ok = Extract<ParentRead, { ok: true }>;

/** A schedule waiting for its trigger price has no end yet: it starts when the price is reached. */
function endWords(
  parent: Ok['parent'],
  t: (key: 'After the trigger price is reached') => string,
  when: (iso: string) => string | null,
): string | null {
  return parent.awaitingTrigger ? t('After the trigger price is reached') : when(parent.projectedEndsAt);
}

/** POV: the newest child's size and the volume or book size it was a share of, as the service stored them. */
function lastSliceWords(
  parent: Ok['parent'],
  t: (key: 'Last slice of book' | 'Last slice of volume', vars: { qty: string; basis: string }) => string,
): string | null {
  const last = parent.children?.at(-1);
  if (parent.kind !== 'pov' || !last?.qty || last.basisQty == null) return null;
  const vars = { qty: fmtAmount(last.qty), basis: fmtAmount(last.basisQty) };
  return parent.povBasis === 'opposite_liquidity' ? t('Last slice of book', vars) : t('Last slice of volume', vars);
}

const CANCEL_INCOMPLETE = 'cancel_incomplete';
const TONE = { active: 'lime', paused: 'warn', halted: 'error', completed: 'neutral', cancelled: 'neutral' } as const;

function pctOf(row: Ok): string | null {
  const done = row.progress?.filledQty ?? null;
  const pct = percentOf(done, row.parent.totalQty, 0);
  return pct !== null && compareDecimals(pct, '100') === 1 ? '100' : pct;
}

/**
 * The average price of the schedule's real child fills: the price, 'not_set' when the service answered and nothing has
 * filled, or null when the result could not be read (drawn as a dash, never as a number).
 */
function averageFill(row: Ok): string | 'not_set' | null {
  if (!row.result) return null;
  const priced = row.result.quotes.find((q) => q.averageFillPrice !== null);
  return priced?.averageFillPrice ?? 'not_set';
}

/** The reason Pause and Resume are off for this schedule, or null when they may be tried. */
function resumeBlock(row: Ok, t: (key: 'Resume blocked cancel incomplete') => string): string | null {
  const reason = row.parent.haltReason ?? row.progress?.haltReason ?? null;
  return reason === CANCEL_INCOMPLETE ? t('Resume blocked cancel incomplete') : null;
}

/** A reason the service gave, in plain words when this room knows it. Unknown text stays as the service wrote it. */
function useReasonWords() {
  const { t } = execCopy.useCopy();
  return (reason: string | null, kind: 'halt' | 'stretch'): { text: string; code: string | null } | null => {
    if (!reason) return null;
    const known: Record<string, string> = {
      cancel_incomplete: t('Halt reason cancel_incomplete'),
      user_pause: t('Stretch reason user_pause'),
      tick_outage: t('Stretch reason tick_outage'),
    };
    const word = known[reason];
    if (word && (kind === 'halt' ? reason === CANCEL_INCOMPLETE : reason !== CANCEL_INCOMPLETE)) return { text: word, code: reason };
    return { text: reason, code: null };
  };
}

function StatusCell({ row }: { row: ParentRead }) {
  const { t } = execCopy.useCopy();
  if (!row.ok) return <Badge tone="error">{t('Could not read')}</Badge>;
  const status = row.progress?.status ?? row.parent.status;
  const misses = row.progress?.missesRecorded ?? row.parent.missesRecorded;
  const emitted = row.progress?.childrenEmitted ?? row.parent.childrenEmitted;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={TONE[status]}>{t(`Status ${status}`)}</Badge>
      {misses > 0 && emitted < row.parent.slicesPlanned ? (
        <Badge tone="warn">{t('Partial: {n} misses', { n: String(misses) })}</Badge>
      ) : null}
    </span>
  );
}

export function AlgoList({
  load,
  empty,
  selectedId,
  onSelect,
  onAction,
  locked,
}: {
  load: Loadable<ParentRead[]>;
  empty: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (parent: Ok['parent'], action: AlgoAction) => void;
  locked: boolean;
}) {
  const { t } = execCopy.useCopy();
  const when = useWhen();
  if (empty) return <EmptyState variant="empty" size="inline" title={t('No schedules known')} reason={t('No schedules known reason')} />;

  const columns: TableColumn<ParentRead>[] = [
    { id: 'market', header: t('Market'), width: 130, pin: 'start', value: (r) => (r.ok ? r.parent.symbol : r.id) },
    { id: 'side', header: t('Side'), width: 56, value: (r) => (r.ok ? (r.parent.side === 'buy' ? t('Buy') : t('Sell')) : null) },
    {
      id: 'kind',
      header: t('Kind'),
      width: 80,
      cell: (r) => (r.ok ? <Badge variant="outline">{r.parent.kind.toUpperCase()}</Badge> : null),
    },
    {
      id: 'total',
      header: t('Total'),
      width: 76,
      numeric: true,
      value: (r) => (r.ok ? r.parent.totalQty : null),
      cell: (r) => (r.ok ? fmtAmount(r.parent.totalQty) : null),
    },
    {
      id: 'filled',
      header: t('Filled'),
      width: 76,
      numeric: true,
      value: (r) => (r.ok ? (r.progress?.filledQty ?? null) : null),
      cell: (r) => (r.ok && r.progress ? fmtAmount(r.progress.filledQty) : null),
    },
    {
      id: 'average',
      header: t('Average fill price'),
      width: 96,
      numeric: true,
      cell: (r) => {
        const avg = r.ok ? averageFill(r) : null;
        return avg === null ? null : avg === 'not_set' ? t('Not set') : fmtPrice(avg, null);
      },
    },
    {
      id: 'progress',
      header: t('Progress'),
      width: 120,
      cell: (r) => {
        const pct = r.ok ? pctOf(r) : null;
        if (pct === null) return null;
        return (
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-1.5 w-16 overflow-hidden rounded-pill bg-field">
              <span className="block h-full bg-lime" style={{ width: `${pct}%` }} />
            </span>
            <span className="if-num">{pct}%</span>
          </span>
        );
      },
    },
    {
      id: 'slices',
      header: t('Slices'),
      width: 70,
      cell: (r) => (r.ok ? `${r.progress?.childrenEmitted ?? r.parent.childrenEmitted} / ${r.parent.slicesPlanned}` : null),
    },
    {
      id: 'misses',
      header: t('Misses'),
      width: 64,
      numeric: true,
      value: (r) => (r.ok ? String(r.progress?.missesRecorded ?? r.parent.missesRecorded) : null),
    },
    { id: 'status', header: t('Status'), width: 200, cell: (r) => <StatusCell row={r} /> },
    {
      id: 'next',
      header: t('Next slice'),
      width: 116,
      value: (r) =>
        r.ok && r.parent.status === 'active'
          ? r.parent.awaitingTrigger
            ? t('After the trigger price is reached')
            : when(r.parent.nextDueAt)
          : null,
    },
    { id: 'ends', header: t('Ends'), width: 116, value: (r) => (r.ok ? endWords(r.parent, t, when) : null) },
    {
      id: 'actions',
      header: t('Actions'),
      width: 230,
      cell: (r) => {
        if (!r.ok) return null;
        const { parent } = r;
        const status = r.progress?.status ?? parent.status;
        const blocked = resumeBlock(r, t);
        const act = (action: AlgoAction, label: string) => (
          <Button
            key={action}
            variant="secondary"
            size={28}
            disabled={locked || ((action === 'resume' || action === 'pause') && blocked !== null)}
            aria-label={`${label} ${parent.id}`}
            onClick={(event) => {
              event.stopPropagation();
              onAction(parent, action);
            }}
          >
            {label}
          </Button>
        );
        return (
          <span className="flex flex-wrap gap-1">
            {status === 'active' || blocked !== null ? act('pause', t('Pause')) : null}
            {status === 'paused' || status === 'halted' ? act('resume', t('Resume')) : null}
            {status === 'active' || status === 'paused' || status === 'halted' ? act('cancel', t('Cancel')) : null}
            {blocked !== null && (status === 'paused' || status === 'halted') ? (
              <span className="basis-full whitespace-normal text-xs text-warn">{blocked}</span>
            ) : null}
          </span>
        );
      },
    },
  ];

  return (
    <Gate load={load}>
      {(rows, asOf) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-fg-2">
            <Freshness asOf={asOf} />
            <span>{t('Schedules re-read every 10 s')}</span>
          </div>
          <Table
            label={t('Schedules')}
            density="dense"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            minWidth={columns.reduce((sum, column) => sum + (typeof column.width === 'number' ? column.width : 0), 0)}
            selection="single"
            selectedIds={selectedId ? new Set([selectedId]) : undefined}
            onSelectionChange={(ids) => {
              const [first] = ids;
              if (first) onSelect(first);
            }}
            onRowActivate={(r) => onSelect(r.id)}
          />
          {locked ? <p className="m-0 text-sm text-warn">{t('Actions locked')}</p> : null}
        </div>
      )}
    </Gate>
  );
}

export function AlgoDetail({ row, onClone }: { row: ParentRead; onClone: (parent: Ok['parent']) => void }) {
  const { t } = execCopy.useCopy();
  const when = useWhen();
  const reasonWords = useReasonWords();
  if (!row.ok) {
    const words = roomWords({ code: row.code ?? undefined });
    return <EmptyState variant="refused" size="inline" title={words.title} reason={words.body} code={words.code} />;
  }
  const { parent, progress } = row;
  const done = progress?.filledQty ?? null;
  const halt = reasonWords(parent.haltReason ?? progress?.haltReason ?? null, 'halt');
  const stretch = reasonWords(parent.scheduleStretchReason ?? null, 'stretch');
  const blocked = resumeBlock(row, t);
  return (
    <section aria-label={t('Schedule detail')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <KeyValue
        density="dense"
        items={[
          { label: t('Schedule id'), value: parent.id, mono: true },
          { label: t('Market'), value: `${parent.symbol}, ${parent.side === 'buy' ? t('Buy') : t('Sell')}, ${parent.kind.toUpperCase()}` },
          {
            label: t('Settings'),
            value: t('{total} over {duration} s, a slice every {seconds} s', {
              total: fmtAmount(parent.totalQty),
              duration: String(Math.round(parent.durationMs / 1000)),
              seconds: String(Math.round(parent.sliceIntervalMs / 1000)),
            }),
            hint: [
              parent.limitPrice ? t('Limit {price}', { price: parent.limitPrice }) : t('No limit'),
              parent.participationBps
                ? parent.povBasis === 'opposite_liquidity'
                  ? t('{bps} bps of opposite-side liquidity', { bps: String(parent.participationBps) })
                  : t('{bps} bps of volume', { bps: String(parent.participationBps) })
                : '',
            ]
              .filter(Boolean)
              .join(', '),
          },
          { label: t('Status'), value: t(`Status ${progress?.status ?? parent.status}`) },
          { label: t('Halt reason'), value: halt ? t('Halt: {reason}', { reason: halt.text }) : null, hint: halt?.code ?? undefined },
          { label: t('Stretch reason'), value: stretch?.text ?? null, hint: stretch?.code ?? undefined },
          {
            label: t('Trigger price'),
            value: parent.triggerPrice
              ? parent.awaitingTrigger
                ? t('Waiting for the trigger price')
                : parent.triggeredAt
                  ? t('Triggered at', { when: when(parent.triggeredAt) ?? parent.triggeredAt })
                  : null
              : null,
            hint: parent.triggerPrice ?? undefined,
          },
          { label: t('Last slice'), value: lastSliceWords(parent, t) },
          { label: t('Slice sizes'), value: parent.randomSeed != null ? t('Random sizes', { seed: String(parent.randomSeed) }) : null },
          {
            label: t('Average fill price'),
            value: (() => {
              const avg = averageFill(row);
              return avg === null ? null : avg === 'not_set' ? t('Not set') : fmtPrice(avg, null);
            })(),
            hint: t('Average fill price hint'),
          },
          {
            label: t('Filled so far'),
            value: done === null ? null : `${fmtAmount(done)} / ${fmtAmount(parent.totalQty)}`,
            hint: t('Counts only fills of the child orders'),
          },
          { label: t('Created'), value: when(parent.createdAt) },
          { label: t('Next slice due'), value: parent.awaitingTrigger ? t('After the trigger price is reached') : when(parent.nextDueAt) },
          { label: t('Projected end'), value: endWords(parent, t, when) },
        ]}
      />
      {blocked ? <Why>{blocked}</Why> : null}
      <p className="m-0 text-sm text-fg-2">{t('Children note')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size={32} onClick={() => onClone(parent)}>
          {t('Create new with these numbers')}
        </Button>
        <span className="text-sm text-fg-2">{t('Schedules are not edited')}</span>
      </div>
    </section>
  );
}
