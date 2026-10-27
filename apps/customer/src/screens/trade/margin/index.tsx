import { Badge, EmptyState, KeyValue, Stat, Table, type BadgeTone, type TableColumn } from '@intafaced/ui';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ScreenProps } from '../../../app/screen-types';
import { useSession } from '../../../features/session/session';
import { UNKNOWN, fmtAmount, fmtPrice } from '../../../data/format';
import { useBalances } from '../desk/data';
import { useNow } from '../desk/hooks';
import { ModeStrip } from '../futures/ModeStrip';
import { PositionRowActions } from '../futures/PositionDialogs';
import { STALE_AFTER_MS, useFuturesRefresh, useMarginCalls, useOpenPositions } from '../futures/data';
import { bpsToPct, healthOf, isLive, liquidationDistancePct, stableOrder, stateOf, totalsOf, type Band } from '../futures/model';
import { isPlaneOff } from '../futures/refusals';
import { freeOf } from '../futures/RiskSummary';
import { navigate } from '../../../app/location';
import { marginCopy } from './margin-copy';

const BAND_TONE: Record<Band, BadgeTone> = { ok: 'lime', watch: 'warn', danger: 'error', liquidation: 'error', unknown: 'neutral' };

/** The settle asset of a derivative symbol ("BTC/USDT:USDT" -> "USDT"); the quote when the symbol names none. */
function settleOf(symbol: string): string {
  const after = symbol.split(':')[1];
  return after ?? symbol.split('/')[1] ?? 'USDT';
}

export default function MarginScreen(_props: ScreenProps) {
  const { t } = marginCopy.useCopy();
  const { userId } = useSession();
  const now = useNow(5_000);
  const refresh = useFuturesRefresh();
  const positions = useOpenPositions();
  const balances = useBalances();
  const rows = positions.status === 'ready' ? stableOrder(positions.data.filter(isLive)) : [];
  const calls = useMarginCalls(rows, positions.status === 'ready');
  const totals = positions.status === 'ready' ? totalsOf(positions.data) : null;
  const planeOff = positions.status === 'refused' && isPlaneOff(positions.code);
  const asset = rows[0] ? settleOf(rows[0].symbol) : 'USDT';
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : `${fmtAmount(v, { places: 4 })} ${asset}`);
  const asOf = positions.status === 'ready' ? positions.asOf : null;
  const stat = {
    asOf,
    now,
    staleAfterMs: STALE_AFTER_MS.positions,
    refused: positions.status === 'refused' || positions.status === 'error',
  } as const;
  const callCount = calls.status === 'ready' ? Object.values(calls.data).filter((c) => c !== null).length : null;
  const bandWord = {
    ok: t('Band ok'),
    watch: t('Band watch'),
    danger: t('Band danger'),
    liquidation: t('Band liquidation'),
    unknown: t('Band unknown'),
  } as const;

  const columns: TableColumn<Position>[] = [
    {
      id: 'contract',
      header: t('Contract'),
      pin: 'start',
      width: 240,
      value: (p) => p.symbol,
      cell: (p) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          {p.symbol} <Badge tone={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? 'Long' : 'Short'}</Badge>
        </span>
      ),
    },
    { id: 'margin', header: t('Margin'), numeric: true, value: (p) => p.collateral, cell: (p) => money(p.collateral) ?? UNKNOWN },
    {
      id: 'maintenance',
      header: t('Maintenance margin'),
      numeric: true,
      value: (p) => p.maintenanceMargin,
      cell: (p) => money(p.maintenanceMargin) ?? UNKNOWN,
    },
    {
      id: 'ratio',
      width: 210,
      header: t('Margin ratio'),
      numeric: true,
      value: (p) => healthOf(p).marginRatioPct,
      cell: (p) => {
        const h = healthOf(p);
        return (
          <span
            className="inline-flex items-center justify-end gap-2"
            title={h.unknownWhy === 'maintenance' ? t('Maintenance not published') : undefined}
          >
            {h.marginRatioPct ? `${h.marginRatioPct}%` : UNKNOWN}
            <Badge className="whitespace-nowrap" tone={BAND_TONE[h.band]}>
              {bandWord[h.band]}
            </Badge>
          </span>
        );
      },
    },
    {
      id: 'liq',
      header: t('Liquidation price'),
      numeric: true,
      value: (p) => p.liquidationPrice,
      cell: (p) => fmtPrice(p.liquidationPrice, p.markPrice),
    },
    {
      id: 'distance',
      header: t('Distance'),
      numeric: true,
      value: (p) => liquidationDistancePct(p),
      cell: (p) => {
        const d = liquidationDistancePct(p);
        return d === null ? UNKNOWN : `${d}%`;
      },
    },
    {
      id: 'state',
      width: 210,
      header: t('State'),
      value: (p) => stateOf(p),
      cell: (p) => {
        const call = p.id && calls.status === 'ready' ? calls.data[p.id] : null;
        return (
          <span className="inline-flex flex-col">
            <span>{stateOf(p)}</span>
            {call ? (
              <span className="text-xs text-warn">
                {t('Margin call called', { n: String(call.sequence), health: `${bpsToPct(call.healthBps)}%` })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'actions',
      width: 130,
      header: t('Actions'),
      headerLabel: t('Actions'),
      align: 'end',
      cell: (p) => (
        <PositionRowActions
          position={p}
          free={freeOf(balances, settleOf(p.symbol))}
          leverageCap={null}
          planeOff={planeOff}
          only={['add', 'reduce']}
          compact
          onChanged={refresh}
        />
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col" data-screen="margin">
      <ModeStrip active="Margin" />
      <div className="mx-auto flex w-full max-w-(--if-w-content,1224px) flex-col gap-8 px-(--if-gutter) py-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-fg">{t('Margin account')}</h1>
          <p className="max-w-3xl text-base text-fg-2">{t('Margin intro')}</p>
        </header>

        {!userId ? (
          <EmptyState
            variant="refused"
            title={t('Sign in title')}
            reason={t('Needs sign in')}
            action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/margin')}` }}
          />
        ) : (
          <section aria-label={t('Margin account')} className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat
              label={t('Free balance')}
              value={money(freeOf(balances, asset))}
              hint={t('Free balance hint', { asset })}
              asOf={balances.status === 'ready' ? balances.asOf : null}
              now={now}
              staleAfterMs={STALE_AFTER_MS.positions}
              refused={balances.status === 'refused' || balances.status === 'error'}
            />
            <Stat label={t('Margin posted')} value={money(totals?.collateral)} {...stat} />
            <Stat label={t('Unrealised PnL')} value={money(totals?.unrealizedPnl)} {...stat} />
            <Stat label={t('Open positions')} value={totals ? String(totals.count) : null} {...stat} />
            <Stat label={t('Margin calls')} value={callCount === null ? null : String(callCount)} />
          </section>
        )}

        {userId ? (
          <section aria-labelledby="margin-health" className="flex flex-col gap-3">
            <h2 id="margin-health" className="text-md font-medium text-fg">
              {t('Position health')}
            </h2>
            <Table
              label={t('Position health table')}
              density="dense"
              columns={columns}
              rows={rows}
              getRowId={(p) => p.id ?? p.symbol}
              status={positions.status === 'loading' ? 'loading' : 'ready'}
              emptyState={
                positions.status === 'refused' || positions.status === 'error' ? (
                  <EmptyState
                    variant={positions.status === 'refused' ? 'refused' : 'unavailable'}
                    size="inline"
                    title={t('Table error')}
                    reason={positions.status === 'refused' ? positions.code : t('Table error')}
                    code={positions.status === 'refused' ? positions.code : undefined}
                    action={positions.status === 'error' ? { label: t('Try again'), onClick: positions.retry } : undefined}
                  />
                ) : (
                  <EmptyState
                    size="inline"
                    title={t('No positions title')}
                    reason={t('No positions body')}
                    action={{ label: t('Open futures desk'), onClick: () => navigate('/trade/futures') }}
                  />
                )
              }
            />
            <p className="text-xs text-fg-2">{t('Band note')}</p>
          </section>
        ) : null}

        <section aria-labelledby="margin-rules" className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h2 id="margin-rules" className="text-md font-medium text-fg">
              {t('Margin rules')}
            </h2>
            <KeyValue
              items={[
                { label: t('Margin mode'), value: t('Isolated only') },
                { label: t('Cross margin'), value: t('Cross margin off') },
                { label: t('Portfolio margin'), value: t('Portfolio margin off') },
                { label: t('Hedge mode'), value: t('Hedge mode off') },
                { label: t('Collateral class'), value: `${t('Collateral cash')}. ${t('Collateral off')}` },
              ]}
              layout="stacked"
            />
            <EmptyState variant="unavailable" size="inline" title={t('Switch mode')} reason={t('Switch mode reason')} />
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="text-md font-medium text-fg">{t('Spot margin')}</h2>
            <EmptyState
              variant="unavailable"
              size="inline"
              title={t('Spot margin title')}
              reason={t('Spot margin reason')}
              action={{ label: t('Trade spot'), href: '/trade/spot/BTC-USDT' }}
              secondaryAction={{ label: t('Bank loans'), href: '/bank/loans' }}
            />
            <h2 className="mt-4 text-md font-medium text-fg">{t('How liquidation works')}</h2>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-fg-2">
              <li>{t('Liquidation point 1')}</li>
              <li>{t('Liquidation point 2')}</li>
              <li>{t('Liquidation point 3')}</li>
              <li>
                {t('Liquidation point 4')}{' '}
                <a className="text-accent-text underline" href="/trade/futures">
                  {t('ADL notice')}
                </a>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
