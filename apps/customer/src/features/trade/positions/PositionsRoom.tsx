// volt-room: /trade/positions
import { useRef, useState, type ReactNode } from 'react';
import { Button, Select } from '@intafaced/ui/lit';
import { MonitorTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { ScrollTable, Waiting } from '../../more';
import { useSession } from '../../session';
import { TabList, usePolled } from '../../protocol';
import { closeWorstPrice } from '../../../screens/trade/futures/VenueFuturesDesk';
import { compareDecimal } from '../../../data/decimal';
import { useVenueMode } from '../use-venue-mode';
import {
  canonicalDecimal,
  draftId,
  keys,
  leverageTimes,
  type AsOf,
  type VenueAccountSummary,
  type VenueFill,
  type VenueIsolatedMargin,
  type VenueLeverageChange,
  type VenueMarket,
  type VenuePosition,
  type VenuePositionMode,
  type VenueUp,
} from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { AsOfLine, Known, OutcomeLine, TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { keepsDraft, useOwner, useVenueActions, useVenueApi, type ActionResult, type RunAction } from '../venue/VenueKit';
import {
  breakEven,
  leverageBpsOfTimes,
  marginRatio,
  notional,
  openingFees,
  percentOf,
  pnlFormula,
  productOf,
  totalsOf,
} from './positions-math';
import { positionsCopy } from './positions-copy';
import { LiquidationAftermath, LiquidationPanel } from './LiquidationPanels';
import { AutoTopUpPanel } from './AutoTopUpPanel';
import { MarginCalls, RiskAlertsPanel } from './RiskAlertsPanel';

/**
 * The positions room (`/trade/positions`, J-derivatives-05): the person's futures positions on every connected venue with
 * product tags and the venue named, totals that are the sum of the rows, each position's details, the venue's position
 * modes and the switch between them where the venue offers one, a leverage change with the venue's margin difference
 * stated before signing, close all from a reviewed list, and the venue sub-accounts with their positions, the margin moved
 * between them, and a position moved where the venue moves positions. Every figure is the venue's own, with
 * its time; the venue holds the margin, INTAFACED holds none of it, and the ledger posts nothing.
 */
export function PositionsRoom({ path }: { path: string }) {
  const { t } = positionsCopy.useCopy();
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
            <Owned>{(owner) => <Room owner={owner} status={status} path={path} />}</Owned>
          </div>
        }
        explain={<p className="lt-hint">{t('explain')}</p>}
      />
    </VenueFrame>
  );
}

function Owned({ children }: { children: (owner: string) => ReactNode }) {
  const { t } = positionsCopy.useCopy();
  const owner = useOwner();
  if (!owner) return <p className="lt-hint">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

/** One connected venue, as its status names it. */
interface Venue {
  readonly id: string;
  readonly name: string;
  readonly down: string | null;
  readonly modes: readonly VenuePositionMode[];
  /** True where the venue moves an open position between the main account and a sub-account. */
  readonly moves: boolean;
}

function venuesOf(status: VenueUp): Venue[] {
  const listed = status.venues ?? [];
  if (listed.length === 0) return [{ id: status.venue.id, name: status.venue.displayName, down: null, modes: ['one_way'], moves: false }];
  return listed
    .filter((v): v is typeof v & { venueId: string } => v.venueId !== null)
    .map((v) => ({
      id: v.venueId,
      name: v.displayName ?? v.venueId,
      down: v.health.state === 'down' ? String((v.health as { reason?: unknown }).reason ?? '') : null,
      modes: v.positionModes ?? ['one_way'],
      moves: v.positionMoves === true,
    }));
}

/** One position row, with the venue it is on. */
interface Row {
  readonly venue: Venue;
  readonly position: VenuePosition;
}

interface VenueRead {
  readonly venue: Venue;
  readonly positions: AsOf<VenuePosition[]> | null;
  readonly fills: VenueFill[];
  readonly failure: string | null;
}

/** How long back the room reads fills for break-even: the venue keeps them; a week covers any open position here. */
const FILLS_WINDOW_MS = 7 * 24 * 3_600_000;

function Room({ owner, status, path }: { owner: string; status: VenueUp; path: string }) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const venues = venuesOf(status);
  const since = useRef(new Date(Date.now() - FILLS_WINDOW_MS).toISOString()).current;
  const { run } = useVenueActions(owner);
  const ids = venues.map((v) => v.id).join(',');
  const reads = usePolled<VenueRead[]>(
    async (signal) => {
      const data = await Promise.all(
        venues.map(async (v): Promise<VenueRead> => {
          if (v.down !== null) return { venue: v, positions: null, fills: [], failure: null };
          const [p, f] = await Promise.all([
            venue.positions(owner, signal, { venueId: v.id }),
            venue.fills(owner, since, signal, { venueId: v.id }),
          ]);
          return {
            venue: v,
            positions: p.ok ? p.data : null,
            fills: f.ok ? f.data.value : [],
            failure: p.ok ? null : p.message,
          };
        }),
      );
      return { ok: true, data };
    },
    `positions:${owner}:${ids}`,
    VENUE_POLL_MS,
  );
  const markets = usePolled<Record<string, VenueMarket[] | null>>(
    async (signal) => {
      const out: Record<string, VenueMarket[] | null> = {};
      for (const v of venues) {
        if (v.down !== null) continue;
        const m = await venue.markets(signal, v.id);
        out[v.id] = m.ok ? m.data.value : null;
      }
      return { ok: true, data: out };
    },
    `positions-markets:${ids}`,
    30_000,
  );
  // null until the venue's listing is read: the product is then 'reading', never 'not published' (a listing read that
  // failed is 'unread').
  const marketOf = (venueId: string, symbol: string): Listed => {
    const listing = markets.data?.[venueId];
    if (listing === undefined) return null;
    if (listing === null) return 'unread';
    return listing.find((m) => m.symbol === symbol);
  };
  const rows: Row[] = (reads.data ?? []).flatMap((r) => (r.positions?.value ?? []).map((position) => ({ venue: r.venue, position })));
  const fillsOf = (venueId: string) => reads.data?.find((r) => r.venue.id === venueId)?.fills ?? [];
  const reload = () => reads.reload();
  const addressed = new URL(path, location.origin).searchParams.get('subAccount');
  const [tab, setTab] = useState<'positions' | 'calls'>(
    new URL(path, location.origin).searchParams.get('tab') === 'margin-calls' ? 'calls' : 'positions',
  );
  const up = venues.find((v) => v.down === null);
  return (
    <TabList
      label={t('tabsLabel')}
      tabs={[
        { id: 'positions', label: t('tabPositions') },
        { id: 'calls', label: t('tabCalls') },
      ]}
      value={tab}
      onChange={setTab}
    >
      {tab === 'calls' ? (
        up ? (
          <MarginCalls owner={owner} venue={up} />
        ) : null
      ) : (
        <>
          <AccountMetrics owner={owner} venues={venues.filter((v) => v.down === null)} />
          <AllPositions
            owner={owner}
            reads={reads.data}
            rows={rows}
            marketOf={marketOf}
            fillsOf={fillsOf}
            run={run}
            onDone={reload}
            test={status.test}
            builder={status.builder}
          />
          <LiquidationAftermath owner={owner} venues={venues.filter((v) => v.down === null)} />
          <Modes
            owner={owner}
            venues={venues}
            perpsOf={(venueId) => (markets.data?.[venueId] ?? []).filter((m) => m.kind === 'perpetual').map((m) => m.symbol)}
            run={run}
          />
          {addressed ? <AddressedSubAccount owner={owner} id={addressed} venue={venues[0]!} /> : null}
          {venues
            .filter((v) => v.down === null)
            .map((v) => (
              <SubAccounts
                key={v.id}
                owner={owner}
                venue={v}
                mainRows={rows.filter((r) => r.venue.id === v.id)}
                marketOf={(symbol) => marketOf(v.id, symbol)}
                run={run}
                onDone={reload}
              />
            ))}
        </>
      )}
    </TabList>
  );
}

/** A market as the room knows it: the venue's listing entry, undefined where the listing has none, `null` while the
 * listing is being read, `'unread'` where reading it failed. */
type Listed = VenueMarket | undefined | null | 'unread';
/** The listing entry itself, for the figures that need one. */
const entryOf = (m: Listed): VenueMarket | undefined => (m && m !== 'unread' ? m : undefined);

function PositionCells({ row, market }: { row: Row; market: Listed }) {
  const { t } = positionsCopy.useCopy();
  const p = row.position;
  return (
    <>
      <td data-cell="venue">{row.venue.name}</td>
      <td data-cell="product">{t(`product_${market === null ? 'reading' : market === 'unread' ? 'unread' : productOf(market)}`)}</td>
      <td data-cell="market">{p.symbol}</td>
      <td data-cell="side">{t(`side_${p.side}`)}</td>
      <td className="lt-mono" data-cell="size">
        {p.size}
      </td>
      <td className="lt-mono" data-cell="entry">
        {p.entryPrice}
      </td>
      <td className="lt-mono" data-cell="mark">
        {p.markPrice}
      </td>
      <td className="lt-mono" data-cell="notional">
        {notional(p)}
      </td>
      <td className="lt-mono" data-cell="margin">
        {p.margin}
      </td>
      <td className="lt-mono" data-cell="unrealised">
        {p.unrealisedPnl}
      </td>
      <td className="lt-mono" data-cell="leverage">
        {t('leverageCell', { times: String(leverageTimes(p.leverageBps)), mode: t(`mode_${p.marginMode}`) })}
      </td>
    </>
  );
}

function useHeaders(): string[] {
  const { t } = positionsCopy.useCopy();
  return [
    t('hVenue'),
    t('hProduct'),
    t('hMarket'),
    t('hSide'),
    t('hSize'),
    t('hEntry'),
    t('hMark'),
    t('hNotional'),
    t('hMargin'),
    t('hUnrealised'),
    t('hLeverage'),
  ];
}

/** The totals row: each money column the sum of the rows above it. */
function TotalRow({ rows, extra = 0 }: { rows: readonly VenuePosition[]; extra?: number }) {
  const { t } = positionsCopy.useCopy();
  const total = totalsOf(rows);
  return (
    <tr data-row="total">
      <th scope="row" colSpan={7}>
        {t('totalRow', { count: String(total.count) })}
      </th>
      <td className="lt-mono" data-cell="notional">
        {total.notional}
      </td>
      <td className="lt-mono" data-cell="margin">
        {total.margin}
      </td>
      <td className="lt-mono" data-cell="unrealised">
        {total.unrealisedPnl}
      </td>
      <td colSpan={1 + extra} />
    </tr>
  );
}

const rowKey = (r: Row) => `${r.venue.id}:${r.position.symbol}`;

function AllPositions({
  owner,
  reads,
  rows,
  marketOf,
  fillsOf,
  run,
  onDone,
  test,
  builder,
}: {
  owner: string;
  reads: VenueRead[] | null;
  rows: Row[];
  marketOf: (venueId: string, symbol: string) => Listed;
  fillsOf: (venueId: string) => VenueFill[];
  run: RunAction;
  onDone: () => void;
  test: boolean;
  builder: VenueUp['builder'];
}) {
  const { t } = positionsCopy.useCopy();
  const headers = useHeaders();
  const [open, setOpen] = useState<{ kind: 'detail' | 'leverage' | 'margin'; key: string } | null>(null);
  const openRow = open ? (rows.find((r) => rowKey(r) === open.key) ?? null) : null;
  // The liquidation panel names its venue and market, not a row: it stays open when the venue closes the position.
  const [liquidation, setLiquidation] = useState<{ venue: Venue; symbol: string } | null>(null);
  return (
    <section className="lt-stack" aria-label={t('allTitle')} data-testid="positions-all">
      <h2>
        {t('allTitle')} <TestMark test={test} />
      </h2>
      {(reads ?? []).map((r) =>
        r.venue.down !== null ? (
          <p key={r.venue.id} className="lt-refusal" role="alert" data-venue-down={r.venue.id}>
            {t('venueDown', { venue: r.venue.name, reason: r.venue.down })}
          </p>
        ) : r.failure ? (
          <p key={r.venue.id} className="lt-refusal" role="alert">
            {t('readFailed', { venue: r.venue.name, detail: r.failure })}
          </p>
        ) : null,
      )}
      {reads === null ? <Waiting label={t('allTitle')} /> : null}
      {reads !== null && rows.length === 0 ? <p className="lt-hint">{t('none')}</p> : null}
      {rows.length > 0 ? (
        <ScrollTable label={t('allTitle')} headers={[...headers, '']}>
          {rows.map((row) => (
            <tr key={rowKey(row)} data-venue={row.venue.id} data-symbol={row.position.symbol}>
              <PositionCells row={row} market={marketOf(row.venue.id, row.position.symbol)} />
              <td>
                <Button tone="secondary" onClick={() => setOpen({ kind: 'detail', key: rowKey(row) })}>
                  {t('details')}
                </Button>{' '}
                <Button tone="secondary" onClick={() => setOpen({ kind: 'leverage', key: rowKey(row) })}>
                  {t('changeLeverage')}
                </Button>{' '}
                {row.position.marginMode === 'isolated' ? (
                  <Button tone="secondary" onClick={() => setOpen({ kind: 'margin', key: rowKey(row) })}>
                    {t('adjustMargin')}
                  </Button>
                ) : null}{' '}
                <Button tone="secondary" onClick={() => setLiquidation({ venue: row.venue, symbol: row.position.symbol })}>
                  {t('liquidationButton')}
                </Button>
              </td>
            </tr>
          ))}
          <TotalRow rows={rows.map((r) => r.position)} extra={1} />
        </ScrollTable>
      ) : null}
      {(reads ?? []).map((r) => (r.positions ? <AsOfLine key={r.venue.id} asOf={r.positions.asOf} /> : null))}
      {open?.kind === 'detail' && openRow ? <Detail row={openRow} fills={fillsOf(openRow.venue.id)} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'leverage' && openRow ? (
        <Leverage
          key={open.key}
          row={openRow}
          market={marketOf(openRow.venue.id, openRow.position.symbol)}
          owner={owner}
          run={run}
          onDone={onDone}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === 'margin' && openRow ? (
        <IsolatedMargin key={open.key} row={openRow} owner={owner} run={run} onDone={onDone} onClose={() => setOpen(null)} />
      ) : null}
      {liquidation ? (
        <LiquidationPanel
          key={`liquidation:${liquidation.venue.id}:${liquidation.symbol}`}
          owner={owner}
          venue={liquidation.venue}
          symbol={liquidation.symbol}
          onClose={() => setLiquidation(null)}
        />
      ) : null}
      <CloseAll rows={rows} marketOf={marketOf} owner={owner} run={run} onDone={onDone} builder={builder} />
    </section>
  );
}

/** One position's details (#2): entry, break-even adjusted by the opening fees, mark, margin ratio and the P&L formula. */
function Detail({ row, fills, onClose }: { row: Row; fills: VenueFill[]; onClose: () => void }) {
  const { t } = positionsCopy.useCopy();
  const p = row.position;
  const fees = openingFees(p, fills);
  const ratio = marginRatio(p);
  const pnl = pnlFormula(p);
  return (
    <section className="lt-stack" aria-label={t('detailTitle', { symbol: p.symbol, venue: row.venue.name })} data-testid="position-detail">
      <h3>{t('detailTitle', { symbol: p.symbol, venue: row.venue.name })}</h3>
      <dl>
        <dt>{t('detailEntry')}</dt>
        <dd className="lt-mono" data-line="entry">
          {p.entryPrice}
        </dd>
        <dt>{t('detailBreakEven')}</dt>
        <dd className="lt-mono" data-line="break-even">
          <span data-value="break-even">{breakEven(p, fills)}</span>{' '}
          <span className="lt-hint" data-line="break-even-rule">
            {t('detailBreakEvenRule', { sign: p.side === 'long' ? '+' : '−', fees, size: p.size })}
          </span>
        </dd>
        <dt>{t('detailMark')}</dt>
        <dd className="lt-mono" data-line="mark">
          {p.markPrice}
        </dd>
        <dt>{t('detailMarginRatio')}</dt>
        <dd className="lt-mono" data-line="margin-ratio">
          {ratio === null ? (
            t('detailMarginRatioNone')
          ) : ratio === 'liquidation' ? (
            t('detailMarginRatioLiquidation')
          ) : (
            <>
              <span data-value="margin-ratio">{t('detailMarginRatioValue', { ratio })}</span>{' '}
              <span className="lt-hint" data-line="margin-ratio-rule">
                {t('detailMarginRatioRule', {
                  maintenance: p.maintenanceMargin?.known ? p.maintenanceMargin.value : '',
                  margin: p.margin,
                  pnl: p.unrealisedPnl,
                })}
              </span>
            </>
          )}
        </dd>
        <dt>{t('detailPnl')}</dt>
        <dd className="lt-mono" data-line="pnl">
          <span data-value="pnl">{p.unrealisedPnl}</span>{' '}
          <span className="lt-hint" data-line="pnl-formula">
            {t(pnl.words === 'long' ? 'detailPnlLong' : 'detailPnlShort', pnl)}
          </span>
        </dd>
        <dt>{t('detailLiquidation')}</dt>
        <dd className="lt-mono" data-line="liquidation">
          <Known value={p.liquidationPrice} render={(x) => x} />
        </dd>
      </dl>
      <Button tone="secondary" onClick={onClose}>
        {t('close')}
      </Button>
    </section>
  );
}

/**
 * A leverage change (#4): allowed up to the venue's published cap, shown; the venue's margin difference is read and stated
 * before anything is signed, and nothing changes until the person confirms and signs.
 */
function Leverage({
  row,
  market,
  owner,
  run,
  onDone,
  onClose,
}: {
  row: Row;
  market: Listed;
  owner: string;
  run: RunAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const p = row.position;
  const cap = entryOf(market)?.maxLeverageBps ?? null;
  const [times, setTimes] = useState(String(leverageTimes(p.leverageBps)));
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<VenueLeverageChange | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const draft = useRef<{ bps: number; id: string } | null>(null);
  const words = { symbol: p.symbol, venue: row.venue.name };

  async function check() {
    setProblem(null);
    setReview(null);
    setResult(null);
    const bps = leverageBpsOfTimes(times);
    if (bps === null) return setProblem(t('levWhole'));
    if (cap !== null && bps > cap)
      return setProblem(t('levAboveCap', { ...words, times: String(leverageTimes(bps)), cap: String(leverageTimes(cap)) }));
    const read = await venue.leverageChange(owner, { symbol: p.symbol, leverageBps: bps, marginMode: p.marginMode, venueId: row.venue.id });
    if (!read.ok)
      return setProblem(
        t(read.code === 'trade.venue.not_offered' ? 'levNoDifference' : 'levRefused', { venue: row.venue.name, detail: read.message }),
      );
    setReview(read.data.value);
  }

  async function confirm() {
    if (!review) return;
    if (!draft.current || draft.current.bps !== review.leverageBps) draft.current = { bps: review.leverageBps, id: draftId() };
    const answer = await run(
      { kind: 'update_leverage', symbol: p.symbol, leverageBps: review.leverageBps, marginMode: review.marginMode },
      { actionKey: keys.leverage(owner, p.symbol, review.marginMode, review.leverageBps, draft.current.id), venueId: row.venue.id },
    );
    if (!keepsDraft(answer)) draft.current = null;
    setResult(answer);
    onDone();
  }

  const diff = review ? review.difference : null;
  return (
    <section className="lt-stack" aria-label={t('levTitle', words)} data-testid="position-leverage">
      <h3>{t('levTitle', words)}</h3>
      <p data-line="cap">{cap === null ? t('levCapNone', words) : t('levCap', { ...words, times: String(leverageTimes(cap)) })}</p>
      <label className="lt-field">
        <span>{t('levInput')}</span>
        <input
          inputMode="numeric"
          aria-label={t('levInput')}
          value={times}
          onChange={(e) => {
            setTimes(e.target.value);
            setReview(null);
          }}
        />
      </label>
      <Button tone="secondary" onClick={() => void check()}>
        {t('levReview')}
      </Button>
      {problem ? (
        <p className="lt-refusal" role="alert" data-testid="position-leverage-problem">
          {problem}
        </p>
      ) : null}
      {review ? (
        <div data-testid="position-leverage-review">
          <dl>
            <dt>{t('levNow')}</dt>
            <dd className="lt-mono" data-line="margin-now">
              {review.marginNow}
            </dd>
            <dt>{t('levAfter', { times: String(leverageTimes(review.leverageBps)) })}</dt>
            <dd className="lt-mono" data-line="margin-after">
              {review.marginAfter}
            </dd>
          </dl>
          <p data-line="difference" data-difference={review.difference}>
            {diff === null || /^0(\.0*)?$/.test(diff)
              ? t('levSame')
              : diff.startsWith('-')
                ? t('levReleased', { amount: diff.slice(1) })
                : t('levPosted', { amount: diff })}
          </p>
          <p className="lt-hint">{t('levNothingYet')}</p>
          <Button onClick={() => void confirm()}>{t('levConfirm', { times: String(leverageTimes(review.leverageBps)) })}</Button>
        </div>
      ) : null}
      <OutcomeLine result={result} owner={owner} venueId={row.venue.id} />
      <Button tone="secondary" onClick={onClose}>
        {t('close')}
      </Button>
    </section>
  );
}

/**
 * Account metrics (J-derivatives-06 #1): each connected venue's own figures for the account, exact as the venue reports
 * them, with their time: equity, free, used margin, maintenance margin and the margin ratio.
 */
function AccountMetrics({ owner, venues }: { owner: string; venues: readonly Venue[] }) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const ids = venues.map((v) => v.id).join(',');
  const reads = usePolled<{ venue: Venue; summary: AsOf<VenueAccountSummary> | null; failure: string | null }[]>(
    async (signal) => {
      const data = await Promise.all(
        venues.map(async (v) => {
          const r = await venue.accountSummary(owner, signal, v.id);
          return { venue: v, summary: r.ok ? r.data : null, failure: r.ok ? null : r.message };
        }),
      );
      return { ok: true, data };
    },
    `account-summary:${owner}:${ids}`,
    VENUE_POLL_MS,
  );
  return (
    <section className="lt-stack" aria-label={t('metricsTitle')} data-testid="account-metrics">
      <h2>{t('metricsTitle')}</h2>
      {reads.data === null ? <Waiting label={t('metricsTitle')} /> : null}
      {(reads.data ?? []).map(({ venue: v, summary, failure }) => (
        <div key={v.id} data-venue={v.id}>
          <h3>{t('metricsVenue', { venue: v.name })}</h3>
          {failure ? (
            <p className="lt-refusal" role="alert">
              {t('metricsNotOffered', { venue: v.name, detail: failure })}
            </p>
          ) : null}
          {summary ? (
            <>
              <p className="lt-hint">{t('metricsLead', { venue: v.name, asset: summary.value.asset })}</p>
              <dl>
                <dt>{t('metricsEquity')}</dt>
                <dd className="lt-mono" data-metric="equity">
                  {summary.value.equity}
                </dd>
                <dt>{t('metricsFree')}</dt>
                <dd className="lt-mono" data-metric="free">
                  {summary.value.free}
                </dd>
                <dt>{t('metricsUsed')}</dt>
                <dd className="lt-mono" data-metric="used">
                  {summary.value.usedMargin}
                </dd>
                <dt>{t('metricsMaintenance')}</dt>
                <dd className="lt-mono" data-metric="maintenance">
                  {summary.value.maintenanceMargin}
                </dd>
                <dt>{t('metricsRatio')}</dt>
                <dd className="lt-mono" data-metric="ratio">
                  {summary.value.marginRatio.known
                    ? t('metricsRatioValue', { ratio: percentOf(summary.value.marginRatio.value) })
                    : t('metricsRatioNone')}
                </dd>
              </dl>
              <AsOfLine asOf={summary.asOf} />
            </>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * Margin on one isolated position (J-derivatives-06 #2 #3): the venue's margin now, its own limit for removing it and the
 * free balance, read before anything is signed; an addition or removal is one change the wallet signs, sent once under
 * its draft's key, and the margin and liquidation price after are read back from the venue. A removal past the limit is
 * refused by the venue in its own words, before the wallet is asked.
 */
function IsolatedMargin({
  row,
  owner,
  run,
  onDone,
  onClose,
}: {
  row: Row;
  owner: string;
  run: RunAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const p = row.position;
  const words = { symbol: p.symbol, venue: row.venue.name };
  const read = usePolled<AsOf<VenueIsolatedMargin> | { failure: string }>(
    async (signal) => {
      const r = await venue.isolatedMargin(owner, { symbol: p.symbol, venueId: row.venue.id }, signal);
      return { ok: true, data: r.ok ? r.data : { failure: r.message } };
    },
    `isolated-margin:${owner}:${row.venue.id}:${p.symbol}`,
    VENUE_POLL_MS,
  );
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [after, setAfter] = useState<VenueIsolatedMargin | null>(null);
  const draft = useRef<{ direction: 'add' | 'remove'; amount: string; id: string } | null>(null);
  const now = read.data && 'value' in read.data ? read.data : null;

  async function change(direction: 'add' | 'remove') {
    setProblem(null);
    setResult(null);
    setAfter(null);
    let canonical: string;
    try {
      canonical = canonicalDecimal(amount);
    } catch {
      return setProblem(t('marginEnterAmount'));
    }
    if ((compareDecimal(canonical, '0') ?? 0) <= 0) return setProblem(t('marginEnterAmount'));
    const d = draft.current;
    if (!d || d.direction !== direction || d.amount !== canonical) draft.current = { direction, amount: canonical, id: draftId() };
    const answer = await run(
      {
        kind: 'update_isolated_margin',
        symbol: p.symbol,
        direction,
        amount: canonical,
        changeKey: keys.isolatedMargin(owner, p.symbol, direction, draft.current!.id),
      },
      { venueId: row.venue.id },
    );
    if (!keepsDraft(answer)) draft.current = null;
    setResult(answer);
    if (answer.kind === 'outcome' && answer.outcome.accepted) {
      const back = await venue.isolatedMargin(owner, { symbol: p.symbol, venueId: row.venue.id });
      if (back.ok) setAfter(back.data.value);
    }
    read.reload();
    onDone();
  }

  return (
    <section className="lt-stack" aria-label={t('marginTitle', words)} data-testid="position-margin">
      <h3>{t('marginTitle', words)}</h3>
      <p className="lt-hint">{t('marginLead', words)}</p>
      {read.data && 'failure' in read.data ? (
        <p className="lt-refusal" role="alert">
          {t('marginNotOffered', { venue: row.venue.name, detail: read.data.failure })}
        </p>
      ) : null}
      {now ? (
        <>
          <dl>
            <dt>{t('marginNow')}</dt>
            <dd className="lt-mono" data-line="margin">
              {now.value.margin}
            </dd>
            <dt>{t('marginMinimum')}</dt>
            <dd className="lt-mono" data-line="minimum">
              {now.value.minimumMargin}
            </dd>
            <dt>{t('marginRemovable')}</dt>
            <dd className="lt-mono" data-line="removable">
              {now.value.removable}
            </dd>
            <dt>{t('marginFree')}</dt>
            <dd className="lt-mono" data-line="free">
              {now.value.free}
            </dd>
            <dt>{t('marginLiquidation')}</dt>
            <dd className="lt-mono" data-line="liquidation">
              <Known value={now.value.liquidationPrice} render={(x) => x} />
            </dd>
          </dl>
          <p className="lt-hint" data-line="rule">
            {t('marginRule', { venue: row.venue.name, rule: now.value.rule })}
          </p>
          <AsOfLine asOf={now.asOf} />
          <label className="lt-field">
            <span>{t('marginAmount', { asset: now.value.asset })}</span>
            <input
              inputMode="decimal"
              aria-label={t('marginAmount', { asset: now.value.asset })}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <Button onClick={() => void change('add')}>{t('marginAdd')}</Button>{' '}
          <Button tone="secondary" onClick={() => void change('remove')}>
            {t('marginRemove')}
          </Button>
        </>
      ) : read.data === null ? (
        <Waiting label={t('marginTitle', words)} />
      ) : null}
      {problem ? (
        <p className="lt-refusal" role="alert" data-testid="position-margin-problem">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} venueId={row.venue.id} />
      {after ? (
        <p data-testid="position-margin-after">
          {t('marginAfter', {
            venue: row.venue.name,
            margin: after.margin,
            liquidation: after.liquidationPrice.known ? after.liquidationPrice.value : '—',
          })}
        </p>
      ) : null}
      {now ? <AutoTopUpPanel owner={owner} symbol={p.symbol} venueName={row.venue.name} /> : null}
      {now ? <RiskAlertsPanel owner={owner} symbol={p.symbol} venueName={row.venue.name} /> : null}
      <Button tone="secondary" onClick={onClose}>
        {t('close')}
      </Button>
    </section>
  );
}

/**
 * Close all (#5): a reviewed list of every open position on every venue, then each closed once by its own reduce-only
 * order on its own venue. A venue whose account has not yet approved our builder fee is named in the review, and its
 * one-time approval is signed before its closes, as every order review asks for it. The review's close ids are held
 * until each answers definitely, so a second press is the same closes, never a second order.
 */
function CloseAll({
  rows,
  marketOf,
  owner,
  run,
  onDone,
  builder,
}: {
  rows: Row[];
  marketOf: (venueId: string, symbol: string) => Listed;
  owner: string;
  run: RunAction;
  onDone: () => void;
  builder: VenueUp['builder'];
}) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const [review, setReview] = useState<{ id: string; rows: Row[]; approve: Venue[] } | null>(null);
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [busy, setBusy] = useState(false);

  async function open() {
    setResults({});
    const listed = rows.filter((r) => !/^0(\.0*)?$/.test(r.position.size));
    const venues = [...new Map(listed.map((r) => [r.venue.id, r.venue])).values()];
    const approve: Venue[] = [];
    if (builder) {
      for (const v of venues) {
        const read = await venue.builderFeeApproval(owner, undefined, v.id);
        if (!read.ok || compareDecimal(read.data.value, builder.feeBps) === -1) approve.push(v);
      }
    }
    setReview({ id: draftId(), rows: listed, approve });
  }

  async function confirm() {
    if (!review || busy) return;
    setBusy(true);
    const out: Record<string, ActionResult> = {};
    const refusedOn = new Map<string, ActionResult>();
    try {
      if (builder)
        for (const v of review.approve) {
          const answer = await run(
            { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
            { actionKey: keys.builderApproval(owner, builder.address, builder.feeBps, v.id, review.id), venueId: v.id },
          );
          if (answer.kind !== 'outcome' || !answer.outcome.accepted) refusedOn.set(v.id, answer);
        }
      for (const [i, row] of review.rows.entries()) {
        const refused = refusedOn.get(row.venue.id);
        if (refused) {
          out[rowKey(row)] = refused;
          setResults({ ...out });
          continue;
        }
        const p = row.position;
        const tick = entryOf(marketOf(row.venue.id, p.symbol))?.tickSize ?? '0';
        out[rowKey(row)] = await run(
          {
            kind: 'place_order',
            symbol: p.symbol,
            side: p.side === 'long' ? 'sell' : 'buy',
            type: 'limit',
            amount: p.size,
            price: closeWorstPrice(p, tick),
            timeInForce: 'IOC',
            reduceOnly: true,
            clientOrderKey: keys.close(owner, p.symbol, `all${i}-${review.id}`),
            builderFee: null,
          },
          { venueId: row.venue.id },
        );
        setResults({ ...out });
      }
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="lt-stack" data-testid="positions-close-all">
      <Button tone="secondary" onClick={() => void open()}>
        {t('closeAll')}
      </Button>
      {review ? (
        <section className="lt-stack" aria-label={t('closeAllTitle')} data-testid="positions-close-all-review">
          <h3>{t('closeAllTitle')}</h3>
          {review.rows.length === 0 ? (
            <p className="lt-hint">{t('closeAllNone')}</p>
          ) : (
            <>
              <p className="lt-hint">{t('closeAllLead')}</p>
              {builder
                ? review.approve.map((v) => (
                    <p key={v.id} data-approve-venue={v.id}>
                      {t('closeAllApprove', { venue: v.name, fee: builder.feeBps })}
                    </p>
                  ))
                : null}
              <ul>
                {review.rows.map((row) => (
                  <li key={rowKey(row)} data-venue={row.venue.id} data-symbol={row.position.symbol}>
                    {t('closeAllRow', {
                      side: t(`side_${row.position.side}`),
                      size: row.position.size,
                      symbol: row.position.symbol,
                      venue: row.venue.name,
                    })}
                    {results[rowKey(row)] ? <OutcomeLine result={results[rowKey(row)]!} owner={owner} venueId={row.venue.id} /> : null}
                  </li>
                ))}
              </ul>
              <Button disabled={busy} onClick={() => void confirm()}>
                {t('closeAllConfirm', { count: String(review.rows.length) })}
              </Button>{' '}
            </>
          )}
          <Button tone="secondary" disabled={busy} onClick={() => setReview(null)}>
            {t('closeAllCancel')}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The position modes (#3): each venue's modes, offered only where the venue offers them, the others with the reason; a
 * venue that offers more than one gets the switch, one perpetual at a time.
 */
function Modes({
  owner,
  venues,
  perpsOf,
  run,
}: {
  owner: string;
  venues: Venue[];
  perpsOf: (venueId: string) => string[];
  run: RunAction;
}) {
  const { t } = positionsCopy.useCopy();
  return (
    <section className="lt-stack" aria-label={t('modesTitle')} data-testid="positions-modes">
      <h2>{t('modesTitle')}</h2>
      {venues.map((v) => (
        <div key={v.id} className="lt-stack">
          <dl data-venue={v.id}>
            <dt>{t('modeOneWay')}</dt>
            <dd data-mode="one_way" data-offered={String(v.modes.includes('one_way'))}>
              {v.modes.includes('one_way')
                ? t(v.modes.length === 1 ? 'modeCurrent' : 'modeOffered', { venue: v.name })
                : t('modeOneWayNotOffered', { venue: v.name })}
            </dd>
            <dt>{t('modeHedge')}</dt>
            <dd data-mode="hedge" data-offered={String(v.modes.includes('hedge'))}>
              {v.modes.includes('hedge') ? t('modeOffered', { venue: v.name }) : t('modeHedgeNotOffered', { venue: v.name })}
            </dd>
          </dl>
          {v.modes.length > 1 && v.down === null && perpsOf(v.id).length > 0 ? (
            <ModeSwitch owner={owner} venue={v} symbols={perpsOf(v.id)} run={run} />
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * The switch on a venue that offers more than one mode (#3): the mode the venue reports for one perpetual, and one
 * signed change to another it offers. The venue takes it or refuses it; its reason is shown as it gave it.
 */
function ModeSwitch({ owner, venue: v, symbols, run }: { owner: string; venue: Venue; symbols: string[]; run: RunAction }) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const [picked, setPicked] = useState('');
  const symbol = symbols.includes(picked) ? picked : symbols[0]!;
  const mode = usePolled(
    (signal) => venue.positionMode(owner, { symbol, venueId: v.id }, signal),
    `position-mode:${owner}:${v.id}:${symbol}`,
    VENUE_POLL_MS,
  );
  const [result, setResult] = useState<ActionResult | null>(null);
  const draft = useRef<{ id: string; of: string } | null>(null);
  const now = mode.data?.value ?? null;
  const nameOf = (m: VenuePositionMode) => t(m === 'hedge' ? 'modeHedge' : 'modeOneWay');

  async function choose(target: VenuePositionMode) {
    setResult(null);
    const of = `${symbol}|${target}`;
    if (!draft.current || draft.current.of !== of) draft.current = { id: draftId(), of };
    const changeKey = keys.positionMode(owner, symbol, target, draft.current.id);
    const answer = await run({ kind: 'set_position_mode', symbol, mode: target, changeKey }, { venueId: v.id });
    if (!keepsDraft(answer)) draft.current = null;
    setResult(answer);
    mode.reload();
  }

  return (
    <fieldset className="lt-stack" data-testid="positions-mode-switch" data-venue={v.id}>
      <legend>{t('modeSwitchTitle', { venue: v.name })}</legend>
      <Select
        label={t('modeSwitchMarket')}
        value={symbol}
        onChange={(value) => {
          setPicked(value);
          setResult(null);
        }}
        options={symbols}
      />
      {mode.failure ? (
        <p className="lt-refusal" role="alert" data-refusal={mode.failure.code}>
          {t('modeNotKnown', { venue: v.name, detail: mode.failure.message })}
        </p>
      ) : (
        <p data-line="mode-now" data-symbol={symbol}>
          {t('modeNow', { symbol, venue: v.name })}: <span data-value="mode-now">{now ? nameOf(now) : t('modeReading')}</span>
        </p>
      )}
      {v.modes.map((m) => (
        <Button key={m} tone="secondary" disabled={now === null || now === m} onClick={() => void choose(m)}>
          {t('modeChoose', { symbol, mode: nameOf(m) })}
        </Button>
      ))}
      <p className="lt-hint">{t('modeHedgeNote', { venue: v.name })}</p>
      <AsOfLine asOf={mode.data?.asOf ?? null} />
      <OutcomeLine result={result} owner={owner} venueId={v.id} />
    </fieldset>
  );
}

/**
 * One venue's sub-accounts (#6 #7): each with its positions and totals, read as its owner (the main wallet); the margin
 * moved between the main account and a sub-account as one signed venue transfer, shown on both; and a position move:
 * one signed venue action where the venue moves positions, refused in words where it moves none.
 */
function SubAccounts({
  owner,
  venue: v,
  mainRows,
  marketOf,
  run,
  onDone,
}: {
  owner: string;
  venue: Venue;
  mainRows: Row[];
  marketOf: (symbol: string) => Listed;
  run: RunAction;
  onDone: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const subs = usePolled((signal) => venue.subAccounts(owner, signal, v.id), `subs:${owner}:${v.id}`, VENUE_POLL_MS);
  const main = usePolled((signal) => venue.balances(owner, signal, undefined, v.id), `main-b:${owner}:${v.id}`, VENUE_POLL_MS);
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<'into_sub_account' | 'out_of_sub_account'>('into_sub_account');
  const [chosen, setChosen] = useState('');
  const [amount, setAmount] = useState('');
  const [moveSymbol, setMoveSymbol] = useState('');
  const [positionDirection, setPositionDirection] = useState<'into_sub_account' | 'out_of_sub_account'>('into_sub_account');
  const [problem, setProblem] = useState<string | null>(null);
  const [positionRefusal, setPositionRefusal] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [positionResult, setPositionResult] = useState<ActionResult | null>(null);
  const draft = useRef<{ id: string; of: string } | null>(null);
  const positionDraft = useRef<{ id: string; of: string } | null>(null);
  const list = subs.data?.value ?? [];
  const sub = chosen || list[0]?.subAccount || '';
  const words = { venue: v.name };
  const mainUsdc = main.data?.value.find((b) => b.asset === 'USDC');
  // The chosen sub-account's positions: what can move out of it.
  const subHeld = usePolled(
    (signal) => venue.positions(owner, signal, { venueId: v.id, ...(sub ? { subAccount: sub } : {}) }),
    `subs-move:${owner}:${v.id}:${sub}`,
    VENUE_POLL_MS,
  );
  const movable =
    positionDirection === 'into_sub_account'
      ? mainRows.map((r) => r.position.symbol)
      : sub
        ? (subHeld.data?.value ?? []).map((p) => p.symbol)
        : [];
  const symbolToMove = movable.includes(moveSymbol) ? moveSymbol : (movable[0] ?? '');

  async function open() {
    setProblem(null);
    setResult(null);
    if (name.trim() === '') return setProblem(t('enterName'));
    const subAccountKey = keys.ownSubAccount(owner, name);
    setResult(await run({ kind: 'create_sub_account', name: name.trim(), subAccountKey }, { actionKey: subAccountKey, venueId: v.id }));
    subs.reload();
  }

  async function move() {
    setProblem(null);
    setResult(null);
    if (!sub) return;
    let exact: string;
    try {
      exact = canonicalDecimal(amount);
    } catch {
      return setProblem(t('enterAmount'));
    }
    if (exact === '0' || exact.startsWith('-')) return setProblem(t('enterAmount'));
    const of = `${sub}|${direction}|${exact}`;
    if (!draft.current || draft.current.of !== of) draft.current = { id: draftId(), of };
    const moveKey = keys.ownMove(owner, draft.current.id);
    const answer = await run(
      { kind: 'sub_account_transfer', subAccount: sub, direction, asset: 'USDC', amount: exact, moveKey },
      { actionKey: moveKey, venueId: v.id },
    );
    if (!keepsDraft(answer)) draft.current = null;
    setResult(answer);
    main.reload();
    onDone();
  }

  /** The whole position and its margin, moved by the venue in one signed action; refused in words where it moves none. */
  async function movePosition() {
    setPositionRefusal(null);
    setPositionResult(null);
    if (!sub || !symbolToMove) return;
    if (!v.moves) return setPositionRefusal(t('positionMoveRefused', words));
    const of = `${sub}|${positionDirection}|${symbolToMove}`;
    if (!positionDraft.current || positionDraft.current.of !== of) positionDraft.current = { id: draftId(), of };
    const moveKey = keys.positionMove(owner, positionDraft.current.id);
    const answer = await run(
      { kind: 'move_position', subAccount: sub, direction: positionDirection, symbol: symbolToMove, moveKey },
      { actionKey: moveKey, venueId: v.id },
    );
    if (!keepsDraft(answer)) positionDraft.current = null;
    setPositionResult(answer);
    subHeld.reload();
    onDone();
  }

  return (
    <section className="lt-stack" aria-label={t('subsTitle', words)} data-testid="positions-subs" data-venue={v.id}>
      <h2>{t('subsTitle', words)}</h2>
      <p className="lt-hint">{t('subsLead')}</p>
      {subs.failure ? (
        <p className="lt-refusal" role="alert" data-refusal={subs.failure.code}>
          {t('subsNotOffered', { ...words, detail: subs.failure.message })}
        </p>
      ) : null}
      <p data-line="main-free">
        {t('mainFree')}:{' '}
        <span className="lt-mono" data-value="main-free">
          {mainUsdc ? mainUsdc.free : '0'}
        </span>
      </p>
      {subs.data && list.length === 0 ? <p className="lt-hint">{t('subsNone', words)}</p> : null}
      {list.map((s) => (
        <SubAccountCard key={s.subAccount} owner={owner} venue={v} id={s.subAccount} name={s.name} marketOf={marketOf} />
      ))}
      <label className="lt-field">
        <span>{t('subName')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('subName')} />
      </label>
      <Button tone="secondary" onClick={() => void open()}>
        {t('subOpen')}
      </Button>
      {list.length > 0 ? (
        <fieldset className="lt-stack" data-testid="positions-move-margin">
          <legend>{t('moveTitle')}</legend>
          <label className="lt-field">
            <span>{t('moveSub')}</span>
            <select value={sub} onChange={(e) => setChosen(e.target.value)} aria-label={t('moveSub')}>
              {list.map((s) => (
                <option key={s.subAccount} value={s.subAccount}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{t('moveDirection')}</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} aria-label={t('moveDirection')}>
              <option value="into_sub_account">{t('intoSub')}</option>
              <option value="out_of_sub_account">{t('outOfSub')}</option>
            </select>
          </label>
          <label className="lt-field">
            <span>{t('moveAmount')}</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={t('moveAmount')} />
          </label>
          <Button onClick={() => void move()}>{t('moveButton')}</Button>
        </fieldset>
      ) : null}
      {list.length > 0 ? (
        <fieldset className="lt-stack" data-testid="positions-move-position">
          <legend>{t('positionMoveTitle')}</legend>
          <p className="lt-hint">{t(v.moves ? 'positionMoveLead' : 'positionMoveNone', words)}</p>
          <Select
            label={t('positionMoveDirection')}
            value={positionDirection}
            onChange={(value) => setPositionDirection(value === 'out_of_sub_account' ? 'out_of_sub_account' : 'into_sub_account')}
            options={[
              { value: 'into_sub_account', label: t('intoSub') },
              { value: 'out_of_sub_account', label: t('outOfSub') },
            ]}
          />
          {movable.length > 0 ? (
            <>
              <label className="lt-field">
                <span>{t('positionMovePick')}</span>
                <select value={symbolToMove} onChange={(e) => setMoveSymbol(e.target.value)} aria-label={t('positionMovePick')}>
                  {movable.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
              </label>
              <Button tone="secondary" onClick={() => void movePosition()}>
                {t('positionMoveButton')}
              </Button>
            </>
          ) : (
            <p className="lt-hint" data-line="nothing-to-move">
              {t('positionMoveEmpty')}
            </p>
          )}
          {positionRefusal ? (
            <p className="lt-refusal" role="alert" data-testid="positions-move-position-refused">
              {positionRefusal}
            </p>
          ) : null}
          <OutcomeLine result={positionResult} owner={owner} venueId={v.id} />
        </fieldset>
      ) : null}
      {problem ? (
        <p className="lt-refusal" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} venueId={v.id} />
    </section>
  );
}

/** One sub-account's positions and totals, and its free USDC, read as its owner. */
function SubAccountCard({
  owner,
  venue: v,
  id,
  name,
  marketOf,
}: {
  owner: string;
  venue: Venue;
  id: string;
  name: string;
  marketOf: (symbol: string) => Listed;
}) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const headers = useHeaders();
  const positions = usePolled(
    (signal) => venue.positions(owner, signal, { venueId: v.id, subAccount: id }),
    `sub-p:${owner}:${v.id}:${id}`,
    VENUE_POLL_MS,
  );
  const balances = usePolled((signal) => venue.balances(owner, signal, id, v.id), `sub-b:${owner}:${v.id}:${id}`, VENUE_POLL_MS);
  const rows = positions.data?.value ?? [];
  const usdc = balances.data?.value.find((b) => b.asset === 'USDC');
  return (
    <article className="lt-stack" data-testid="positions-sub" data-sub-account={id}>
      <h3>{t('subTitle', { name })}</h3>
      <p data-line="sub-free">
        {t('subFree')}:{' '}
        <span className="lt-mono" data-value="sub-free">
          {usdc ? usdc.free : '0'}
        </span>
      </p>
      {positions.failure ? (
        <p className="lt-refusal" role="alert" data-refusal={positions.failure.code}>
          {t('addressedRefused', { detail: positions.failure.message })}
        </p>
      ) : null}
      {positions.data && rows.length === 0 ? <p className="lt-hint">{t('subNoPositions')}</p> : null}
      {rows.length > 0 ? (
        <ScrollTable label={t('subTitle', { name })} headers={headers}>
          {rows.map((p) => (
            <tr key={p.symbol} data-symbol={p.symbol}>
              <PositionCells row={{ venue: v, position: p }} market={marketOf(p.symbol)} />
            </tr>
          ))}
          <TotalRow rows={rows} />
        </ScrollTable>
      ) : null}
      <AsOfLine asOf={positions.data?.asOf ?? null} />
    </article>
  );
}

/** A sub-account named in the address (`?subAccount=`): read as this wallet's, or refused when it is not one of its own. */
function AddressedSubAccount({ owner, id, venue: v }: { owner: string; id: string; venue: Venue }) {
  const { t } = positionsCopy.useCopy();
  const venue = useVenueApi();
  const positions = usePolled(
    (signal) => venue.positions(owner, signal, { venueId: v.id, subAccount: id }),
    `addr-p:${owner}:${v.id}:${id}`,
    VENUE_POLL_MS,
  );
  const rows = positions.data?.value ?? [];
  return (
    <section className="lt-stack" aria-label={t('addressedTitle', { id })} data-testid="positions-addressed">
      <h2>{t('addressedTitle', { id })}</h2>
      {positions.failure ? (
        <p className="lt-refusal" role="alert" data-refusal={positions.failure.code}>
          {t('addressedRefused', { detail: positions.failure.message })}
        </p>
      ) : null}
      {positions.data ? (
        rows.length === 0 ? (
          <p className="lt-hint">{t('subNoPositions')}</p>
        ) : (
          <ul>
            {rows.map((p) => (
              <li key={p.symbol}>
                {p.symbol} {p.size}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
