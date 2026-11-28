// volt-room: /trade/journal
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { MonitorTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import {
  TRADE_JOURNAL_CLOSED_TRADES,
  TRADE_JOURNAL_MAX_DAYS,
  TRADE_JOURNAL_MAX_TRADES,
  type JournalTrade,
  type TradeJournal,
} from '@intafaced/contracts/trade-journal-procedures';
import { ScrollTable, Waiting } from '../../more';
import { useApi, useSession } from '../../session';
import { TabList, usePolled } from '../../protocol';
import { displayAmount } from '../../../shared/money';
import { useVenueMode } from '../use-venue-mode';
import { VENUE_POLL_MS } from '../venue/poll';
import { TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { useAsOfText, useOwner } from '../venue/VenueKit';
import { journalCopy } from './journal-copy';
import { equityOf, equityPlaces, feesOf, minusOneRLessFees, type EquityPoint } from './journal-model';
import { JournalTrades, tradeFromPath } from './JournalTrades';

type View = 'trades' | 'equity';
const DAY_MS = 86_400_000;

/**
 * The trade journal (`/trade/journal`; `?view=equity` opens Equity): the person's closed perpetual trades on their own
 * venue account, read from the venue by svc-trade (record `@intafaced/contracts/trade-journal-procedures`), and on
 * Equity two lines over the same trades, what they made and what they would have made keeping their own stops and
 * daily loss limit, with the gap at the end; any point opens how it was worked out (J-portfolio-19). Read only: nothing is
 * sent to the venue and the ledger posts nothing.
 */
export function JournalRoom({ path }: { path: string }) {
  const { t } = journalCopy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  const deskLink = (
    <a className="lt-link" href="/trade/futures">
      {t('deskLink')}
    </a>
  );
  const off = (state: RoomState, link = false) => (
    <MonitorTemplate
      title={t('title')}
      state={state}
      mode="pro"
      figures={[]}
      roomAction={link ? deskLink : undefined}
      explain={<p className="lt-hint">{t('explain')}</p>}
    />
  );
  if (!userId)
    return off({
      kind: 'empty',
      title: t('signedOutTitle'),
      body: t('signedOutBody'),
      action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` },
    });
  if (mode.mode === 'checking') return off({ kind: 'loading' });
  if (mode.mode === 'off' || !mode.status.available)
    return off({ kind: 'refused', refusal: { variant: 'parked', title: t('title'), body: t('venueOff') } }, true);
  const status = mode.status;
  const first: View = new URL(path, location.origin).searchParams.get('view') === 'equity' ? 'equity' : 'trades';
  return (
    <VenueFrame mode={mode}>
      <MonitorTemplate
        title={t('title')}
        description={t('lead')}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        roomAction={deskLink}
        actions={
          <div className="lt-stack">
            <TestMark test={status.test} />
            <WalletBar />
          </div>
        }
        panels={
          <div className="lt-stack">
            <Owned>{(owner) => <Journal owner={owner} first={first} picked={tradeFromPath(path)} />}</Owned>
          </div>
        }
        explain={<p className="lt-hint">{t('explain')}</p>}
      />
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = journalCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="lt-hint">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

function Journal({ owner, first, picked }: { owner: string; first: View; picked: string | null }) {
  const { t } = journalCopy.useCopy();
  const api = useApi();
  const asOfText = useAsOfText();
  const [view, setView] = useState<View>(first);
  // The record reads at most 90 days back; a day short of it, so a clock a little ahead of the service's still reads.
  const [since] = useState(() => new Date(Date.now() - (TRADE_JOURNAL_MAX_DAYS - 1) * DAY_MS).toISOString());
  const read = usePolled<TradeJournal>(
    (signal) => api.call(TRADE_JOURNAL_CLOSED_TRADES, { owner, since, limit: TRADE_JOURNAL_MAX_TRADES }, { signal }),
    `journal:${owner}:${since}`,
    VENUE_POLL_MS,
  );
  const journal = read.data;
  const choose = (next: View) => {
    setView(next);
    const url = new URL(location.href);
    if (next === 'equity') url.searchParams.set('view', 'equity');
    else url.searchParams.delete('view');
    history.replaceState(history.state, '', url);
  };
  return (
    <TabList
      label={t('tabsLabel')}
      tabs={[
        { id: 'trades', label: t('tabTrades') },
        { id: 'equity', label: t('tabEquity') },
      ]}
      value={view}
      onChange={choose}
    >
      {read.failure ? (
        <p className="lt-hint" role="alert" data-testid="journal-refused">
          {t('refused', { detail: read.failure.message })}
        </p>
      ) : null}
      {!journal ? (
        read.failure ? null : (
          <Waiting label={t('loading')} />
        )
      ) : journal.trades.length === 0 ? (
        <p className="lt-hint" data-testid="journal-none">
          {t('none')}
        </p>
      ) : view === 'trades' ? (
        <JournalTrades journal={journal} picked={picked} />
      ) : (
        <Equity journal={journal} />
      )}
      {journal ? (
        <p className="lt-hint" data-testid="journal-as-of">
          <TestMark test={journal.venue.test} /> {journal.venue.name} · {asOfText(journal.asOf)}
        </p>
      ) : null}
    </TabList>
  );
}

const when = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

function money(value: string, asset: string) {
  return `${displayAmount(value)} ${asset}`;
}

function Equity({ journal }: { journal: TradeJournal }) {
  const { t } = journalCopy.useCopy();
  const equity = useMemo(() => equityOf(journal), [journal]);
  const places = useMemo(() => equityPlaces(equity.points), [equity]);
  const [open, setOpen] = useState<string | null>(null);
  // The venue's perpetuals collateral, in which every trade's result is counted.
  const asset = journal.trades[0]?.feeAsset ?? '';
  const usd = (value: string) => money(value, asset);
  const point = equity.points.find((p) => p.trade.tradeId === open) ?? null;
  const line = (ps: readonly { x: number; y: number }[]) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <section className="lt-stack" aria-labelledby="journal-equity" data-testid="journal-equity">
      <h2 id="journal-equity">{t('equityTitle')}</h2>
      <figure className="lt-chart lt-timeline" data-testid="equity-chart">
        <svg
          viewBox={`0 0 ${places.width} ${places.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('chartLabel')}
          data-points={equity.points.length}
        >
          <line
            className="lt-timeline-zero"
            x1="0"
            x2={places.width}
            y1={places.zeroY}
            y2={places.zeroY}
            vectorEffect="non-scaling-stroke"
          />
          <g className="lt-chart" data-tone="neutral" data-line="made">
            <polyline className="lt-chart-line" points={line(places.made)} vectorEffect="non-scaling-stroke" />
          </g>
          <g className="lt-chart" data-tone="up" data-line="rules">
            <polyline className="lt-chart-line" points={line(places.rules)} vectorEffect="non-scaling-stroke" />
          </g>
          {equity.points.map((p, i) => (
            <g key={p.trade.tradeId} className="lt-chart" data-tone="neutral">
              <line
                className="lt-chart-line lt-timeline-dot"
                x1={places.made[i]!.x}
                x2={places.made[i]!.x}
                y1={places.made[i]!.y}
                y2={places.made[i]!.y}
                vectorEffect="non-scaling-stroke"
                data-point={p.trade.tradeId}
                onClick={() => setOpen(p.trade.tradeId)}
              />
            </g>
          ))}
        </svg>
        <figcaption>
          <span data-testid="equity-legend-made">{t('lineMade')}</span>
          <span data-testid="equity-legend-rules">{t('lineRules')}</span>
        </figcaption>
      </figure>
      <dl className="lt-stack" data-testid="equity-ends">
        <div data-testid="equity-end-made" data-amount={equity.made}>
          {t('endMade', { amount: usd(equity.made) })}
        </div>
        <div data-testid="equity-end-rules" data-amount={equity.rules}>
          {t('endRules', { amount: usd(equity.rules) })}
        </div>
        <div data-testid="equity-gap" data-amount={equity.gap}>
          <strong>{t('gap', { amount: usd(equity.gap) })}</strong>
          <p className="lt-hint">{t('gapExplain', { count: String(equity.points.length) })}</p>
          {equity.left > 0 ? (
            <p className="lt-hint" data-testid="equity-left">
              {t('equityLeft', { count: String(equity.left) })}
            </p>
          ) : null}
        </div>
      </dl>
      <ScrollTable label={t('pointsTitle')} headers={[t('hClosed'), t('hMarket'), t('hMade'), t('hRules'), t('hCounts'), '']}>
        {equity.points.map((p) => (
          <tr key={p.trade.tradeId} data-point={p.trade.tradeId} data-verdict={p.trade.rules.verdict}>
            <td>{when(p.at)}</td>
            <td>{p.trade.symbol}</td>
            <td>{usd(p.made)}</td>
            <td>{usd(p.rules)}</td>
            <td>{t(`v_${p.trade.rules.verdict}`)}</td>
            <td>
              <Button tone="secondary" onClick={() => setOpen(p.trade.tradeId)}>
                {t('open')}
              </Button>
            </td>
          </tr>
        ))}
      </ScrollTable>
      {point ? <PointDetail point={point} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function PointDetail({ point, onClose }: { point: EquityPoint; onClose: () => void }) {
  const { t } = journalCopy.useCopy();
  const trade: JournalTrade = point.trade;
  const r = trade.rules;
  const a = (v: string | null) => (v === null ? t('none_') : money(v, trade.feeAsset));
  const price = (v: string | null) => (v === null ? t('none_') : displayAmount(v));
  const args = {
    net: a(trade.netPnl),
    rules: a(r.netPnl),
    oneR: r.oneR === null ? t('none_') : displayAmount(r.oneR),
    fees: displayAmount(feesOf(trade)),
    stop: price(trade.plannedStop),
    widened: price(r.widenedStop),
    loss: r.dailyLoss ? money(r.dailyLoss.loss, r.dailyLoss.asset) : t('none_'),
    limit: r.dailyLoss ? money(r.dailyLoss.limit, r.dailyLoss.asset) : t('none_'),
    warned: r.dailyLoss ? when(r.dailyLoss.warnedAt) : t('none_'),
  };
  const figures: [string, string, string][] = [
    ['entry', t('fEntry'), price(trade.entryPrice)],
    ['exit', t('fExit'), price(trade.exitPrice)],
    ['size', t('fSize'), price(trade.size)],
    ['first-stop', t('fFirstStop'), price(trade.plannedStop)],
    ...(r.widenedStop !== null ? ([['widened', t('fWidened'), price(r.widenedStop)]] as [string, string, string][]) : []),
    ['one-r', t('fOneR'), r.oneR === null ? t('none_') : a(r.oneR)],
    ['fees', t('fFees'), a(feesOf(trade))],
    ['net', t('fNet'), a(trade.netPnl)],
    ['rules', t('fRules'), a(r.netPnl)],
    ...(r.dailyLoss
      ? ([
          ['limit', t('fLimit'), args.limit],
          ['loss', t('fLoss'), args.loss],
        ] as [string, string, string][])
      : []),
  ];
  // The arithmetic the rules line used, from the same figures: minus 1R less the fees.
  const worked = minusOneRLessFees(trade);
  return (
    <article
      className="lt-stack"
      aria-labelledby="journal-point"
      data-testid="equity-point"
      data-trade={trade.tradeId}
      data-verdict={r.verdict}
    >
      <h3 id="journal-point">
        {t('pointTitle', { market: trade.symbol, side: trade.side === 'long' ? t('long') : t('short'), closed: when(trade.closedAt) })}
      </h3>
      <p data-testid="equity-point-verdict">
        <strong>{t(`v_${r.verdict}`)}</strong>
      </p>
      <p data-testid="equity-point-why" data-worked={worked ?? undefined}>
        {t(`why_${r.verdict}`, args)}
      </p>
      <dl className="lt-stack" data-testid="equity-point-figures">
        {figures.map(([key, label, value]) => (
          <div key={key} data-figure={key}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="lt-actions">
        <Button tone="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </article>
  );
}
