import { useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  Amount,
  Badge,
  Button,
  ChangeText,
  EmptyState,
  Money,
  Pct,
  Price,
  StateBlock,
  StatusChip,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import type { BalanceEntry } from '../../../data/derive';
import { fmtAmount, fmtPctPoints, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { positionsCopy } from './positions-copy';
import { STALE_AFTER_MS, useFuturesRefresh, type MarginCalls } from './data';
import { isStale, closeAllPlan, stableOrder, type Band } from './model';
import { CloseAllDialog, PositionRowActions } from './PositionDialogs';
import { barWidth, freeFor, rowOf, signedAmount } from './positions-logic';
import { futuresRefusal, isPlaneOff } from './refusals';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

// A bar is shape + word + number; the tone only tints it.
const bandTone: Record<Band, string> = {
  ok: 'bg-lime',
  watch: 'bg-warn',
  danger: 'bg-error',
  liquidation: 'bg-error',
  unknown: 'bg-line',
};

function RatioCell({ position, t }: { position: Position; t: T }) {
  const { health } = rowOf(position);
  const width = barWidth(health);
  if (health.marginRatioPct === null)
    return (
      <span title={health.unknownWhy ? t(`Unknown why ${health.unknownWhy}`) : undefined} className="text-fg-2">
        —<span className="sr-only">{health.unknownWhy ? t(`Unknown why ${health.unknownWhy}`) : ''}</span>
      </span>
    );
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span>{t('Ratio value', { pct: health.marginRatioPct, band: t(`Band ${health.band}`) })}</span>
      <span aria-hidden="true" className="h-1.5 w-10 shrink-0 overflow-hidden rounded-pill bg-field">
        <span className={`block h-full ${bandTone[health.band]}`} style={{ width: width ?? '0%' }} />
      </span>
    </span>
  );
}

function StateCell({ position, called, t }: { position: Position; called: boolean; t: T }) {
  const row = rowOf(position);
  // The chip maps a lifecycle state onto the kit's shapes: open = filled dot, closing = clock ring, the rest = dashed.
  const kind = row.state === 'open' ? 'live' : row.state === 'closing' ? 'stale' : 'unknown';
  const word = row.state === 'closing' ? t('State closing') : t(`State ${row.state}`);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusChip kind={kind} density="dense" labels={{ [kind]: word }} reason={row.closingReason ?? undefined} />
      {called ? <Badge tone="warn">{t('Positions margin call badge')}</Badge> : null}
    </span>
  );
}

export function PositionsTable({
  positions,
  marginCalls,
  freeBalances,
  planeOff,
  now,
  onOpen,
  onChanged,
  onReverse,
}: {
  positions: Loadable<Position[]>;
  marginCalls: Loadable<MarginCalls>;
  freeBalances: Loadable<Record<string, BalanceEntry>>;
  planeOff: boolean;
  now: number;
  onOpen(p: Position): void;
  onChanged(): void;
  onReverse?(p: Position): void;
}) {
  const { t } = positionsCopy.useCopy();
  const refresh = useFuturesRefresh();
  const [closeAll, setCloseAll] = useState(false);
  const rows = positions.status === 'ready' ? stableOrder(positions.data) : [];
  const stale = positions.status === 'ready' && isStale(positions.asOf, now, STALE_AFTER_MS.positions);
  const balances = freeBalances.status === 'ready' ? freeBalances.data : null;
  const calls = marginCalls.status === 'ready' ? marginCalls.data : null;
  const plan = closeAllPlan(rows);
  const closeAllOff = planeOff ? t('Reason planeOff') : plan.length === 0 ? t('Close all none') : null;
  const refreshNow = () => {
    refresh();
    if (positions.status === 'error') positions.retry();
  };

  const columns: TableColumn<Position>[] = [
    {
      id: 'contract',
      header: t('Col contract'),
      pin: 'start',
      width: 220,
      cell: (p) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="font-medium">{p.symbol}</span>
          <Badge tone={p.side === 'long' ? 'up' : 'down'}>
            {p.side === 'long' ? t('Side long') : t('Side short')}
            {p.leverage === null ? '' : ` ${fmtAmount(p.leverage, { places: 2 })}x`}
          </Badge>
        </span>
      ),
    },
    { id: 'size', header: t('Col size'), numeric: true, width: 80, cell: (p) => <Amount value={fmtAmount(p.contracts, { places: 8 })} /> },
    { id: 'entry', header: t('Col entry'), numeric: true, width: 90, cell: (p) => <Price value={fmtPrice(p.entryPrice, null)} /> },
    {
      id: 'mark',
      width: 90,
      header: t('Col mark'),
      numeric: true,
      cell: (p) =>
        p.markPrice === null ? (
          <span title={t('Positions mark unavailable')} className="text-fg-2">
            —
          </span>
        ) : (
          <Price value={fmtPrice(p.markPrice, null)} />
        ),
    },
    {
      id: 'pnl',
      header: t('Col pnl'),
      numeric: true,
      width: 130,
      cell: (p) => {
        const value = signedAmount(p.unrealizedPnl, 4);
        return value === null ? (
          <span title={t('Positions mark unavailable')} className="text-fg-2">
            —
          </span>
        ) : (
          <ChangeText value={`${value} (${fmtPctPoints(p.percentage)})`} />
        );
      },
    },
    {
      id: 'margin',
      width: 90,
      header: t('Col margin'),
      numeric: true,
      cell: (p) => <Money value={p.collateral === null ? null : fmtAmount(p.collateral, { places: 4 })} />,
    },
    { id: 'ratio', header: t('Col ratio'), numeric: true, width: 150, cell: (p) => <RatioCell position={p} t={t} /> },
    {
      id: 'liq',
      width: 100,
      header: t('Col liquidation'),
      numeric: true,
      cell: (p) => <Price value={p.liquidationPrice === null ? null : fmtPrice(p.liquidationPrice, null)} />,
    },
    {
      id: 'state',
      header: t('Col state'),
      width: 100,
      cell: (p) => <StateCell position={p} called={p.id !== null && calls?.[p.id] != null} t={t} />,
    },
    {
      id: 'actions',
      header: t('Col actions'),
      width: 150,
      cell: (p) => (
        <PositionRowActions
          position={p}
          compact
          free={freeFor(p.symbol, balances)}
          leverageCap={null}
          planeOff={planeOff}
          stale={stale}
          onChanged={onChanged}
          only={['add', 'leverage', 'protect', 'stop', 'reverse', 'close']}
          {...(onReverse ? { onReverse } : {})}
        />
      ),
    },
  ];

  const refused = positions.status === 'refused' ? positions.code : null;
  const emptyState =
    refused === null ? undefined : refused === 'auth.required' ? (
      <EmptyState
        variant="refused"
        size="inline"
        title={t('Positions signed out title')}
        reason={t('Positions signed out reason')}
        action={{ label: t('Positions sign in'), href: `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}` }}
      />
    ) : isPlaneOff(refused) ? (
      <EmptyState variant="unavailable" size="inline" title={t('Positions plane off title')} reason={t('Positions plane off reason')} />
    ) : (
      <EmptyState
        variant="refused"
        size="inline"
        title={futuresRefusal({ code: refused }).title}
        reason={futuresRefusal({ code: refused }).body}
        code={refused}
      />
    );

  return (
    <section aria-label={t('Positions table label')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip
          kind={positions.status === 'refused' ? 'refused' : undefined}
          asOf={positions.status === 'ready' ? positions.asOf : null}
          now={now}
          staleAfterMs={STALE_AFTER_MS.positions}
          showAsOf
          asOfLabel={t('Positions as of')}
          labels={{
            live: t('Positions chip live'),
            stale: t('Positions chip stale'),
            unknown: t('Positions chip unknown'),
            refused: t('Positions chip refused'),
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {closeAllOff ? <span className="text-2xs text-fg-2">{t('Close all off', { reason: closeAllOff })}</span> : null}
          <Button variant="secondary" size={28} onClick={refreshNow}>
            {t('Positions refresh')}
          </Button>
          <Button variant="sell" size={28} disabled={closeAllOff !== null} onClick={() => setCloseAll(true)}>
            {t('Positions close all')}
          </Button>
        </div>
      </div>
      {stale ? <p className="text-2xs text-warn">{t('Positions stale note')}</p> : null}
      <div className={stale ? 'overflow-x-auto opacity-70' : 'overflow-x-auto'}>
        <Table
          label={t('Positions table label')}
          density="dense"
          className="min-w-[1060px]"
          columns={columns}
          rows={rows}
          getRowId={(p) => rowOf(p).id}
          status={positions.status === 'loading' ? 'loading' : positions.status === 'error' ? 'error' : 'ready'}
          emptyState={
            emptyState ??
            (positions.status === 'empty' || positions.status === 'ready' ? (
              <EmptyState size="inline" title={t('Positions empty title')} reason={t('Positions empty body')} />
            ) : undefined)
          }
          errorState={<StateBlock kind="error" title={t('Positions error title')} onRetry={refreshNow} retryLabel={t('Positions retry')} />}
          onRowActivate={onOpen}
        />
      </div>
      {closeAll ? (
        <CloseAllDialog
          positions={rows}
          onClose={() => setCloseAll(false)}
          onDone={() => {
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
