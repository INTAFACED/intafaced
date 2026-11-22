import { useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Amount, Tag, Button, ChangeText, Price, StateBlock } from '@intafaced/ui/lit';
import { FreshnessChip, Table, type Column } from '@intafaced/ui/lit/templates';
import type { BalanceEntry } from '../../../data/derive';
import { fmtAmount, fmtPctPoints, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { positionsCopy } from './positions-copy';
import { STALE_AFTER_MS, useFuturesRefresh, type MarginCalls, type RiskStops } from './data';
import { isStale, closeAllPlan, stableOrder } from './model';
import { CloseAllDialog, PositionRowActions } from './PositionDialogs';
import { barWidth, freeFor, rowOf, signedAmount } from './positions-logic';
import { futuresRefusal, isPlaneOff } from './refusals';
import { RegionNote } from './notes';

type T = ReturnType<typeof positionsCopy.useCopy>['t'];

function RatioCell({ position, t }: { position: Position; t: T }) {
  const { health } = rowOf(position);
  const width = barWidth(health);
  if (health.marginRatioPct === null)
    return (
      <span title={health.unknownWhy ? t(`Unknown why ${health.unknownWhy}`) : undefined} className="lt-quiet">
        —<span className="lt-sr">{health.unknownWhy ? t(`Unknown why ${health.unknownWhy}`) : ''}</span>
      </span>
    );
  return (
    <span className="lt-row lt-row-end lt-row-nowrap">
      <span>{t('Ratio value', { pct: health.marginRatioPct, band: t(`Band ${health.band}`) })}</span>
      {/* A bar is shape + word + number: the words before it say the ratio and its band. */}
      <meter aria-hidden="true" className="lt-meter" min={0} max={100} value={Number.parseInt(width ?? '0', 10)} data-band={health.band} />
    </span>
  );
}

/** A position's pre-liquidation stop on its row: the level and the mark its close order goes in at, as the service holds them. */
function RiskStopLine({ stop, t }: { stop: RiskStops[string] | undefined; t: T }) {
  if (!stop || stop.status === 'none' || stop.status === 'ended') return null;
  const close = stop.closeOrder?.status;
  const text =
    stop.status === 'fired'
      ? close === 'filled'
        ? t('Risk stop cell closed')
        : close === 'failed' || close === 'cancelled'
          ? t('Risk stop cell failed')
          : t('Risk stop cell closing')
      : stop.triggerPrice === null
        ? t('Risk stop cell no price', { level: stop.level ?? '—' })
        : t('Risk stop cell', { level: stop.level ?? '—', price: fmtPrice(stop.triggerPrice, null) });
  return (
    <span data-testid="risk-stop" className="lt-note">
      {text}
    </span>
  );
}

function StateCell({ position, called, t }: { position: Position; called: boolean; t: T }) {
  const row = rowOf(position);
  // The chip maps a lifecycle state onto the kit's shapes: open = filled dot, closing = clock ring, the rest = dashed.
  const kind = row.state === 'open' ? 'live' : row.state === 'closing' ? 'stale' : 'unknown';
  const word = row.state === 'closing' ? t('State closing') : t(`State ${row.state}`);
  return (
    <span className="lt-stack-tight lt-tight">
      <FreshnessChip asOf={null} staleAfterMs={0} kind={kind} labels={{ [kind]: word }} reason={row.closingReason ?? undefined} />
      {called ? <Tag tone="warn">{t('Positions margin call badge')}</Tag> : null}
    </span>
  );
}

export function PositionsTable({
  positions,
  marginCalls,
  riskStops,
  freeBalances,
  planeOff,
  now,
  onOpen,
  onChanged,
  onReverse,
}: {
  positions: Loadable<Position[]>;
  marginCalls: Loadable<MarginCalls>;
  /** Each live position's pre-liquidation stop; absent where the room does not read them. */
  riskStops?: Loadable<RiskStops>;
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
  const stops = riskStops?.status === 'ready' ? riskStops.data : null;
  const plan = closeAllPlan(rows);
  const closeAllOff = planeOff ? t('Reason planeOff') : plan.length === 0 ? t('Close all none') : null;
  const refreshNow = () => {
    refresh();
    if (positions.status === 'error') positions.retry();
  };

  const columns: Column<Position>[] = [
    {
      key: 'contract',
      label: t('Col contract'),
      cell: (p) => (
        <span className="lt-row lt-row-nowrap">
          <span className="lt-strong">{p.symbol}</span>
          <Tag tone={p.side === 'long' ? 'up' : 'down'}>
            {p.side === 'long' ? t('Side long') : t('Side short')}
            {p.leverage === null ? '' : ` ${fmtAmount(p.leverage, { places: 2 })}x`}
          </Tag>
        </span>
      ),
    },
    { key: 'size', label: t('Col size'), align: 'end', cell: (p) => <Amount value={fmtAmount(p.contracts, { places: 8 })} /> },
    { key: 'entry', label: t('Col entry'), align: 'end', cell: (p) => <Price value={fmtPrice(p.entryPrice, null)} /> },
    {
      key: 'mark',
      label: t('Col mark'),
      align: 'end',
      cell: (p) =>
        p.markPrice === null ? (
          <span title={t('Positions mark unavailable')} className="lt-quiet">
            —
          </span>
        ) : (
          <Price value={fmtPrice(p.markPrice, null)} />
        ),
    },
    {
      key: 'pnl',
      label: t('Col pnl'),
      align: 'end',
      cell: (p) => {
        const value = signedAmount(p.unrealizedPnl, 4);
        return value === null ? (
          <span title={t('Positions mark unavailable')} className="lt-quiet">
            —
          </span>
        ) : (
          <ChangeText value={`${value} (${fmtPctPoints(p.percentage)})`} />
        );
      },
    },
    {
      key: 'margin',
      label: t('Col margin'),
      align: 'end',
      cell: (p) => <Amount data-slot="money" value={p.collateral === null ? null : fmtAmount(p.collateral, { places: 4 })} />,
    },
    {
      key: 'ratio',
      label: t('Col ratio'),
      align: 'end',
      cell: (p) => (
        <>
          <RatioCell position={p} t={t} />
          <RiskStopLine stop={p.id === null ? undefined : stops?.[p.id]} t={t} />
        </>
      ),
    },
    {
      key: 'liq',
      label: t('Col liquidation'),
      align: 'end',
      cell: (p) => <Price value={p.liquidationPrice === null ? null : fmtPrice(p.liquidationPrice, null)} />,
    },
    {
      key: 'state',
      label: t('Col state'),
      cell: (p) => <StateCell position={p} called={p.id !== null && calls?.[p.id] != null} t={t} />,
    },
    {
      key: 'actions',
      label: t('Col actions'),
      cell: (p) => (
        <PositionRowActions
          position={p}
          compact
          free={freeFor(p.symbol, balances)}
          leverageCap={null}
          planeOff={planeOff}
          stale={stale}
          onChanged={onChanged}
          only={['add', 'leverage', 'protect', 'stop', 'riskStop', 'reverse', 'close']}
          {...(onReverse ? { onReverse } : {})}
        />
      ),
    },
  ];

  const refused = positions.status === 'refused' ? positions.code : null;
  const emptyState =
    refused === null ? undefined : refused === 'auth.required' ? (
      <RegionNote
        variant="refused"
        title={t('Positions signed out title')}
        reason={t('Positions signed out reason')}
        action={{ label: t('Positions sign in'), href: `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}` }}
      />
    ) : isPlaneOff(refused) ? (
      <RegionNote variant="unavailable" title={t('Positions plane off title')} reason={t('Positions plane off reason')} />
    ) : (
      <RegionNote
        variant="refused"
        title={futuresRefusal({ code: refused }).title}
        reason={futuresRefusal({ code: refused }).body}
        code={refused}
      />
    );

  return (
    <section aria-label={t('Positions table label')} className="lt-stack">
      <div className="lt-row lt-row-between">
        <FreshnessChip
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
        <div className="lt-row">
          {closeAllOff ? <span className="lt-note">{t('Close all off', { reason: closeAllOff })}</span> : null}
          <Button tone="secondary" size="sm" onClick={refreshNow}>
            {t('Positions refresh')}
          </Button>
          <Button tone="down" size="sm" disabled={closeAllOff !== null} onClick={() => setCloseAll(true)}>
            {t('Positions close all')}
          </Button>
        </div>
      </div>
      {stale ? <p className="lt-note lt-note-warn">{t('Positions stale note')}</p> : null}
      {/* The table keeps its columns in every state; loading, a failed read and an empty list sit in its body. */}
      <Table
        caption={t('Positions table label')}
        mode="pro"
        dense
        columns={columns}
        rows={rows}
        rowKey={(p) => rowOf(p).id}
        onSelect={(key) => {
          const picked = rows.find((p) => rowOf(p).id === key);
          if (picked) onOpen(picked);
        }}
        empty={
          positions.status === 'loading' ? (
            <StateBlock kind="loading" rows={3} label={t('Positions table label')} />
          ) : positions.status === 'error' ? (
            <StateBlock kind="error" title={t('Positions error title')} onRetry={refreshNow} retryLabel={t('Positions retry')} />
          ) : (
            (emptyState ?? <RegionNote title={t('Positions empty title')} reason={t('Positions empty body')} />)
          )
        }
      />
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
