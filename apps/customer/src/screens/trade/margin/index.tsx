import { Button, EmptyState, RefusalBox, Stat, Tag } from '@intafaced/ui/lit';
import { DeskTemplate, KeyValue, Skeleton, Table, type Column } from '@intafaced/ui/lit/templates';
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

/** The band's tag; its word always says the band too. */
const BAND_TONE: Record<Band, 'accent' | 'up' | 'down' | 'neutral'> = {
  ok: 'up',
  watch: 'accent',
  danger: 'down',
  liquidation: 'down',
  unknown: 'neutral',
};

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

  const columns: Column<Position>[] = [
    {
      key: 'contract',
      label: t('Contract'),
      cell: (p) => (
        <span className="lt-toolbar">
          {p.symbol} <Tag tone={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? 'Long' : 'Short'}</Tag>
        </span>
      ),
    },
    { key: 'margin', label: t('Margin'), align: 'end', cell: (p) => money(p.collateral) ?? UNKNOWN },
    { key: 'maintenance', label: t('Maintenance margin'), align: 'end', cell: (p) => money(p.maintenanceMargin) ?? UNKNOWN },
    {
      key: 'ratio',
      label: t('Margin ratio'),
      align: 'end',
      cell: (p) => {
        const h = healthOf(p);
        return (
          <span className="lt-toolbar" title={h.unknownWhy === 'maintenance' ? t('Maintenance not published') : undefined}>
            {h.marginRatioPct ? `${h.marginRatioPct}%` : UNKNOWN}
            <Tag tone={BAND_TONE[h.band]}>{bandWord[h.band]}</Tag>
          </span>
        );
      },
    },
    { key: 'liq', label: t('Liquidation price'), align: 'end', cell: (p) => fmtPrice(p.liquidationPrice, p.markPrice) },
    {
      key: 'distance',
      label: t('Distance'),
      align: 'end',
      cell: (p) => {
        const d = liquidationDistancePct(p);
        return d === null ? UNKNOWN : `${d}%`;
      },
    },
    {
      key: 'state',
      label: t('State'),
      cell: (p) => {
        const call = p.id && calls.status === 'ready' ? calls.data[p.id] : null;
        return (
          <span className="lt-stack-tight">
            <span>{stateOf(p)}</span>
            {call ? (
              <span className="lt-warn">
                {t('Margin call called', { n: String(call.sequence), health: `${bpsToPct(call.healthBps)}%` })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: t('Actions'),
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

  const unread = positions.status === 'refused' || positions.status === 'error';
  const health = (
    <section aria-labelledby="margin-health" className="lt-stack-tight">
      <h2 id="margin-health">{t('Position health')}</h2>
      {positions.status === 'loading' ? (
        <Skeleton shape="rows" />
      ) : rows.length > 0 ? (
        <Table caption={t('Position health table')} mode="pro" columns={columns} rows={rows} rowKey={(p) => p.id ?? p.symbol} />
      ) : unread ? (
        <div className="lt-stack-tight">
          <RefusalBox
            refusal={{
              variant: positions.status === 'refused' ? 'refused' : 'unreachable',
              title: t('Table error'),
              body: positions.status === 'refused' ? positions.code : t('Table error'),
              reference: positions.status === 'refused' ? positions.code : undefined,
            }}
          />
          {positions.status === 'error' ? <Button onClick={positions.retry}>{t('Try again')}</Button> : null}
        </div>
      ) : (
        <EmptyState
          title={t('No positions title')}
          body={t('No positions body')}
          action={<Button onClick={() => navigate('/trade/futures')}>{t('Open futures desk')}</Button>}
        />
      )}
      <p className="lt-hint">{t('Band note')}</p>
    </section>
  );

  return (
    <div data-screen="margin">
      <ModeStrip active="Margin" />
      <DeskTemplate
        title={t('Margin account')}
        description={t('Margin intro')}
        mode="pro"
        state={{ kind: 'ready' }}
        notices={
          userId
            ? []
            : [
                {
                  id: 'sign-in',
                  refusal: {
                    variant: 'refused',
                    title: t('Sign in title'),
                    body: t('Needs sign in'),
                    action: { label: t('Sign in'), href: `/login?redirect=${encodeURIComponent('/trade/margin')}` },
                  },
                },
              ]
        }
        instrument={
          userId ? (
            <section aria-label={t('Margin account')} className="lt-figures" data-count="5">
              <Stat
                label={t('Free balance')}
                value={money(freeOf(balances, asset))}
                money
                hint={t('Free balance hint', { asset })}
                asOf={balances.status === 'ready' ? balances.asOf : null}
                now={now}
                staleAfterMs={STALE_AFTER_MS.positions}
                refused={balances.status === 'refused' || balances.status === 'error'}
              />
              <Stat label={t('Margin posted')} value={money(totals?.collateral)} money {...stat} />
              <Stat label={t('Unrealised PnL')} value={money(totals?.unrealizedPnl)} money {...stat} />
              <Stat label={t('Open positions')} value={totals ? String(totals.count) : null} {...stat} />
              <Stat label={t('Margin calls')} value={callCount === null ? null : String(callCount)} />
            </section>
          ) : null
        }
        chart={userId ? health : null}
        ticket={
          <section aria-labelledby="margin-rules" className="lt-stack-tight">
            <h2 id="margin-rules">{t('Margin rules')}</h2>
            <KeyValue
              rows={[
                { label: t('Margin mode'), value: t('Isolated only') },
                { label: t('Cross margin'), value: t('Cross margin off') },
                { label: t('Portfolio margin'), value: t('Portfolio margin off') },
                { label: t('Hedge mode'), value: t('Hedge mode off') },
                { label: t('Collateral class'), value: `${t('Collateral cash')}. ${t('Collateral off')}` },
              ]}
            />
            <RefusalBox refusal={{ variant: 'parked', title: t('Switch mode'), body: t('Switch mode reason') }} />
          </section>
        }
        orders={
          <div className="lt-stack-tight">
            <h2>{t('Spot margin')}</h2>
            <RefusalBox
              refusal={{
                variant: 'parked',
                title: t('Spot margin title'),
                body: t('Spot margin reason'),
                action: { label: t('Trade spot'), href: '/trade/spot/BTC-USDT' },
              }}
            />
            <a className="lt-link" href="/bank/loans">
              {t('Bank loans')}
            </a>
            <h2>{t('How liquidation works')}</h2>
            <ul className="lt-stack-tight">
              <li>{t('Liquidation point 1')}</li>
              <li>{t('Liquidation point 2')}</li>
              <li>{t('Liquidation point 3')}</li>
              <li>
                {t('Liquidation point 4')}{' '}
                <a className="lt-link" href="/trade/futures">
                  {t('ADL notice')}
                </a>
              </li>
            </ul>
          </div>
        }
      />
    </div>
  );
}
