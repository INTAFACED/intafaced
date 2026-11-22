/** The schedules this device knows, each re-read from the service, and the detail of the one picked. */
import { Button, Tag } from '@intafaced/ui/lit';
import { KeyValue, StatusChip, Table, type Column } from '@intafaced/ui/lit/templates';
import { UNKNOWN, fmtAmount, fmtPrice, type Loadable } from '../rooms/ui';
import { roomWords } from '../rooms/refusals';
import { compareDecimals, percentOf } from '../rooms/math';
import { execCopy } from './copy';
import type { ParentRead } from './data';
import { bpsAsPercent } from './model';
import { Empty, Freshness, Gate, Refusal, Unknown, Why, useWhen } from './parts';

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
/** Each status as the kit's status mark: running is in progress, ended is done, a halt failed, paused and cancelled are open questions. */
const MARK = { active: 'pending', paused: 'unknown', halted: 'failed', completed: 'done', cancelled: 'unknown' } as const;
/** A cell the service has not filled: a dash, as every table draws it. */
const dash = (value: string | null | undefined) => value ?? UNKNOWN;

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
  // Zero fills: the room does not ask for the result, and there is no average to show.
  if (row.progress && compareDecimals(row.progress.filledQty, '0') === 0) return 'not_set';
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
    const known: Record<'halt' | 'stretch', Record<string, string>> = {
      halt: {
        cancel_incomplete: t('Halt reason cancel_incomplete'),
        chase_max_distance: t('Halt reason chase_max_distance'),
        chase_expired: t('Halt reason chase_expired'),
        chase_child_unaccounted: t('Halt reason chase_child_unaccounted'),
      },
      stretch: { user_pause: t('Stretch reason user_pause'), tick_outage: t('Stretch reason tick_outage') },
    };
    const word = Object.hasOwn(known[kind], reason) ? known[kind][reason] : undefined;
    if (word) return { text: word, code: reason };
    return { text: reason, code: null };
  };
}

function StatusCell({ row }: { row: ParentRead }) {
  const { t } = execCopy.useCopy();
  if (!row.ok) return <StatusChip status="failed" label={t('Could not read')} />;
  const status = row.progress?.status ?? row.parent.status;
  const misses = row.progress?.missesRecorded ?? row.parent.missesRecorded;
  const emitted = row.progress?.childrenEmitted ?? row.parent.childrenEmitted;
  return (
    <span>
      <StatusChip status={MARK[status]} label={t(`Status ${status}`)} />
      {misses > 0 && emitted < row.parent.slicesPlanned ? (
        <>
          {' '}
          <StatusChip status="unknown" label={t('Partial: {n} misses', { n: String(misses) })} />
        </>
      ) : null}
    </span>
  );
}

export function AlgoList({
  load,
  empty,
  listing,
  selectedId,
  onSelect,
  onAction,
  locked,
}: {
  load: Loadable<ParentRead[]>;
  /** No schedule id is known yet: the service's list and this device hold none. */
  empty: boolean;
  /** The service's list read: "none" shows only once it has answered, and a refusal is said, never shown as empty. */
  listing: Loadable<unknown>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (parent: Ok['parent'], action: AlgoAction) => void;
  locked: boolean;
}) {
  const { t } = execCopy.useCopy();
  const when = useWhen();
  if (empty)
    return (
      <Gate load={listing} rows={2}>
        {() => <Empty title={t('No schedules known')} body={t('No schedules known reason')} />}
      </Gate>
    );

  const columns: Column<ParentRead>[] = [
    {
      key: 'market',
      label: t('Market'),
      // Every row names its schedule for assistive technology, whatever its status: a finished row has no action buttons
      // to carry the id.
      cell: (r) => (
        <>
          {r.ok ? r.parent.symbol : r.id}
          {r.ok ? (
            <span className="lt-sr" data-testid="schedule-row-name">
              {t('Schedule {id}', { id: r.id })}
            </span>
          ) : null}
        </>
      ),
    },
    { key: 'side', label: t('Side'), cell: (r) => dash(r.ok ? (r.parent.side === 'buy' ? t('Buy') : t('Sell')) : null) },
    { key: 'kind', label: t('Kind'), cell: (r) => (r.ok ? <Tag tone="neutral">{r.parent.kind.toUpperCase()}</Tag> : UNKNOWN) },
    { key: 'total', label: t('Total'), align: 'end', cell: (r) => dash(r.ok ? fmtAmount(r.parent.totalQty) : null) },
    { key: 'filled', label: t('Filled'), align: 'end', cell: (r) => dash(r.ok && r.progress ? fmtAmount(r.progress.filledQty) : null) },
    {
      key: 'average',
      label: t('Average fill price'),
      align: 'end',
      cell: (r) => {
        const avg = r.ok ? averageFill(r) : null;
        return avg === null ? UNKNOWN : avg === 'not_set' ? t('Not set') : fmtPrice(avg, null);
      },
    },
    {
      key: 'progress',
      label: t('Progress'),
      cell: (r) => {
        const pct = r.ok ? pctOf(r) : null;
        if (pct === null) return UNKNOWN;
        return (
          <span className="lt-toolbar">
            <meter className="lt-meter" aria-hidden="true" min={0} max={100} value={Number(pct)} />
            <span>{pct}%</span>
          </span>
        );
      },
    },
    {
      key: 'slices',
      label: t('Slices'),
      cell: (r) => {
        if (!r.ok) return UNKNOWN;
        const emitted = r.progress?.childrenEmitted ?? r.parent.childrenEmitted;
        // A chase has no slice plan: it re-prices one child, so the count is the children placed so far.
        return r.parent.kind === 'chase' ? `${emitted}` : `${emitted} / ${r.parent.slicesPlanned}`;
      },
    },
    {
      key: 'misses',
      label: t('Misses'),
      align: 'end',
      cell: (r) => dash(r.ok ? String(r.progress?.missesRecorded ?? r.parent.missesRecorded) : null),
    },
    { key: 'status', label: t('Status'), cell: (r) => <StatusCell row={r} /> },
    {
      key: 'next',
      label: t('Next slice'),
      cell: (r) =>
        dash(
          r.ok && r.parent.status === 'active'
            ? r.parent.awaitingTrigger
              ? t('After the trigger price is reached')
              : when(r.parent.nextDueAt)
            : null,
        ),
    },
    { key: 'ends', label: t('Ends'), cell: (r) => dash(r.ok ? endWords(r.parent, t, when) : null) },
    {
      key: 'actions',
      label: t('Actions'),
      cell: (r) => {
        if (!r.ok) return UNKNOWN;
        const { parent } = r;
        const status = r.progress?.status ?? parent.status;
        const blocked = resumeBlock(r, t);
        const act = (action: AlgoAction, label: string) => (
          <Button
            key={action}
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
          <span className="lt-actions">
            {status === 'active' || blocked !== null ? act('pause', t('Pause')) : null}
            {status === 'paused' || status === 'halted' ? act('resume', t('Resume')) : null}
            {status === 'active' || status === 'paused' || status === 'halted' ? act('cancel', t('Cancel')) : null}
            {blocked !== null && (status === 'paused' || status === 'halted') ? <span className="lt-hint">{blocked}</span> : null}
          </span>
        );
      },
    },
  ];

  return (
    <Gate load={load}>
      {(rows, asOf) => (
        <div className="lt-body">
          <div className="lt-toolbar">
            <Freshness asOf={asOf} />
            <span className="lt-hint">{t('Schedules re-read every 10 s')}</span>
          </div>
          {listing.status === 'refused' || listing.status === 'error' ? (
            <Why code={listing.status === 'refused' ? listing.code : undefined}>{t('Schedule list unread')}</Why>
          ) : (
            <p className="lt-hint">{t('Schedule list window')}</p>
          )}
          <Table
            caption={t('Schedules')}
            mode="pro"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            selected={selectedId ?? undefined}
            onSelect={onSelect}
            empty="Nothing to show"
          />
          {locked ? <p className="lt-hint">{t('Actions locked')}</p> : null}
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
    return <Refusal words={words} />;
  }
  const { parent, progress } = row;
  const done = progress?.filledQty ?? null;
  const halt = reasonWords(parent.haltReason ?? progress?.haltReason ?? null, 'halt');
  const stretch = reasonWords(parent.scheduleStretchReason ?? null, 'stretch');
  const blocked = resumeBlock(row, t);
  return (
    <section aria-label={t('Schedule detail')} className="lt-col-main">
      <KeyValue
        rows={[
          { label: t('Schedule id'), value: parent.id, mono: true },
          { label: t('Market'), value: `${parent.symbol}, ${parent.side === 'buy' ? t('Buy') : t('Sell')}, ${parent.kind.toUpperCase()}` },
          parent.kind === 'chase'
            ? {
                label: t('Settings'),
                value: t('{total} over {duration} s, one order that follows the book', {
                  total: fmtAmount(parent.totalQty),
                  duration: String(Math.round(parent.durationMs / 1000)),
                }),
                hint:
                  parent.chaseMaxDistanceBps != null
                    ? t('Maximum chase distance {pct} %', { pct: bpsAsPercent(parent.chaseMaxDistanceBps) })
                    : undefined,
              }
            : {
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
          ...(parent.kind === 'chase'
            ? [
                { label: t('Chase start price'), value: parent.chaseStartPrice ? fmtPrice(parent.chaseStartPrice, null) : null },
                { label: t('Chase current price'), value: parent.chasePrice ? fmtPrice(parent.chasePrice, null) : null },
                { label: t('Chase re-prices'), value: parent.chaseReprices == null ? null : String(parent.chaseReprices) },
              ]
            : []),
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
          {
            label: t('Next slice due'),
            value:
              parent.kind === 'chase'
                ? t('A chase has one order')
                : parent.awaitingTrigger
                  ? t('After the trigger price is reached')
                  : when(parent.nextDueAt),
          },
          { label: t('Projected end'), value: endWords(parent, t, when) },
        ].map((r) => ({ label: r.label, value: r.value ?? <Unknown />, note: r.hint, ltr: 'mono' in r ? r.mono : undefined }))}
      />
      {blocked ? <Why>{blocked}</Why> : null}
      <p className="lt-hint">{t('Children note')}</p>
      <div className="lt-toolbar">
        <Button onClick={() => onClone(parent)}>{t('Create new with these numbers')}</Button>
        <span className="lt-hint">{t('Schedules are not edited')}</span>
      </div>
    </section>
  );
}
