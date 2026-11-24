import { useRef, useState } from 'react';
import { Button, Checkbox } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { usePolled } from '../../protocol';
import { Section, Waiting } from '../../more';
import { displayAmount } from '../../../shared/money';
import { compareDecimal } from '../../../data/decimal';
import { closeWorstPrice } from '../../../screens/trade/futures/VenueFuturesDesk';
import { useAsk } from '../../../screens/trade/desk/VenueOrderChanges';
import type { VenueMode } from '../use-venue-mode';
import { draftId, keys, type VenuePosition, type VenueUp } from '../venue-api';
import { VENUE_POLL_MS } from '../venue/poll';
import { OutcomeLine, TestMark, VenueFrame, WalletBar } from '../venue/volt/VoltVenue';
import { keepsDraft, useOwner, useVenueActions, useVenueApi, type ActionResult, type RunAction } from '../venue/VenueKit';
import {
  cancelBatches,
  isLiveVenueOrder,
  judgeVenueCancel,
  openVenuePositions,
  summariseVenueOrders,
  type CancelEverythingVerdict,
} from './risk-model';
import { riskCopy } from './risk-copy';
import { CancelEverything, OtherSections, type T } from './risk-parts';

/**
 * The Risk room on the person's own venue account (the launch money model): the open orders and the
 * positions are the venue's own, read from it; Cancel all is one signed `cancel_orders` naming every open order in every
 * market (in batches of what the venue takes in one action); a close is the futures desk's own reduce-only close, signed
 * per position. Each answer is the venue's, leg by leg: a partial or unknown answer is never shown as done, and nothing
 * is sent again. INTAFACED holds none of it and the ledger posts nothing.
 */
export function VenueRisk({ mode }: { mode: Extract<VenueMode, { mode: 'on' }> }) {
  const { t } = riskCopy.useCopy();
  const status = mode.status;
  if (!status.available) return null;
  return (
    <VenueFrame mode={mode}>
      <MonitorTemplate
        title={t('title')}
        description={t('venueLead')}
        state={{ kind: 'ready' }}
        mode="pro"
        figures={[]}
        actions={
          <div className="lt-stack">
            <TestMark test={status.test} />
            <WalletBar />
          </div>
        }
        explain={<p className="lt-hint">{t('explain')}</p>}
        panels={
          <div className="lt-stack">
            <Owned status={status} t={t} />
            <OtherSections t={t} />
          </div>
        }
      />
    </VenueFrame>
  );
}

function Owned({ status, t }: { status: VenueUp; t: T }) {
  const owner = useOwner();
  if (!owner)
    return (
      <Section title={t('exposure')}>
        <p data-testid="risk-venue-connect">{t('venueConnect')}</p>
      </Section>
    );
  return <Account owner={owner} status={status} t={t} />;
}

function Account({ owner, status, t }: { owner: string; status: VenueUp; t: T }) {
  const venue = useVenueApi();
  const { run } = useVenueActions(owner);
  const [ask, signing] = useAsk(run);
  const orders = usePolled((signal) => venue.openOrders(owner, signal), `risk-venue-orders:${owner}`, VENUE_POLL_MS);
  const positions = usePolled((signal) => venue.positions(owner, signal), `risk-venue-positions:${owner}`, VENUE_POLL_MS);
  const markets = usePolled((signal) => venue.markets(signal), 'risk-venue-markets', VENUE_POLL_MS);
  // One cancel id per confirmed count until every batch answers definitely: a second press is the same request.
  const draft = useRef<string | null>(null);
  // A read that failed is a count unknown, even with an older answer held: never the last count as if read now.
  const summary = orders.data && !orders.failure ? summariseVenueOrders(orders.data.value) : null;
  const live = positions.data && !positions.failure ? openVenuePositions(positions.data.value) : null;

  async function cancelEverything(): Promise<CancelEverythingVerdict> {
    const open = (orders.data?.value ?? []).filter(isLiveVenueOrder);
    const batches = cancelBatches(
      open.map((o) => ({ symbol: o.symbol, venueClientOrderId: o.venueClientOrderId! })),
      status.cancelsPerAction ?? 0,
    );
    if (batches.length === 0) return { kind: 'refused', reason: 'no_batch', detail: '' };
    draft.current ??= draftId();
    const answers: ActionResult[] = [];
    for (const [i, batch] of batches.entries()) {
      const answer = await ask({ kind: 'cancel_orders', orders: batch }, { actionKey: keys.cancelBatch(owner, `${draft.current}-${i}`) });
      answers.push(answer);
      if (answer.kind !== 'outcome' || !answer.outcome.accepted) break;
    }
    if (answers.every((a) => !keepsDraft(a))) draft.current = null;
    return judgeVenueCancel(open.length, answers);
  }
  const reload = () => {
    orders.reload();
    positions.reload();
  };

  return (
    <>
      <Section title={t('exposure')}>
        <h3>{t('ordersHeading')}</h3>
        {summary === null ? (
          orders.failure ? (
            <p role="alert">{t('venueOrdersUnread')}</p>
          ) : (
            <Waiting label={t('ordersLoading')} />
          )
        ) : summary.total === 0 ? (
          <p>{t('ordersNone')}</p>
        ) : (
          <>
            <p>{summary.total === 1 ? t('ordersCountOne') : t('ordersCount', { count: String(summary.total) })}</p>
            <ul className="lt-rows" data-testid="risk-orders-markets">
              {summary.markets.map((market) => (
                <li key={market.symbol}>{t('ordersMarket', { symbol: market.symbol, count: String(market.count) })}</li>
              ))}
            </ul>
          </>
        )}
        <h3>{t('positionsHeading')}</h3>
        {live === null ? (
          positions.failure ? (
            <p role="alert">{t('positionsUnread')}</p>
          ) : (
            <Waiting label={t('positionsLoading')} />
          )
        ) : (
          <p>
            {live.length === 0
              ? t('positionsNone')
              : live.length === 1
                ? t('positionsCountOne')
                : t('positionsCount', { count: String(live.length) })}
          </p>
        )}
      </Section>
      <Section title={t('cancelHeading')}>
        <p>{t('cancelLead')}</p>
        <CancelEverything count={summary?.total ?? 0} onSend={cancelEverything} onDone={reload} t={t} hidden={signing} />
      </Section>
      <Section title={t('reduceHeading')}>
        <p>{t('reduceLead')}</p>
        {live === null ? (
          positions.failure ? (
            <p role="alert">{t('positionsUnread')}</p>
          ) : (
            <Waiting label={t('positionsLoading')} />
          )
        ) : (
          <Reduce
            owner={owner}
            positions={live}
            tickOf={(symbol) => markets.data?.value.find((m) => m.symbol === symbol)?.tickSize ?? null}
            run={ask}
            signing={signing}
            onDone={reload}
            builder={status.builder}
            t={t}
          />
        )}
      </Section>
    </>
  );
}

const rowId = (p: VenuePosition) => `${p.symbol}:${p.side}`;

function Reduce({
  owner,
  positions,
  tickOf,
  run,
  signing,
  onDone,
  builder,
  t,
}: {
  owner: string;
  positions: VenuePosition[];
  /** The market's tick, from the venue's listing; null until the listing is read (a close is priced on it). */
  tickOf: (symbol: string) => string | null;
  run: RunAction;
  signing: boolean;
  onDone: () => void;
  /** Our builder fee, which every order on the venue carries; an account that has not approved it signs the approval first. */
  builder: VenueUp['builder'];
  t: T;
}) {
  const venue = useVenueApi();
  // The one-time builder-fee approval the review asks for, with its id held until the venue answers it definitely.
  const [approval, setApproval] = useState<{ id: string; done: boolean; answer: ActionResult | null } | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // The positions under review, each with its close id: a press after an answer that was not definite is the same close,
  // and a position the venue answered definitely is never sent again.
  const [review, setReview] = useState<Array<{ position: VenuePosition; id: string }> | null>(null);
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const chosen = positions.filter((p) => picked.has(rowId(p)));
  const priced = review !== null && review.every((row) => tickOf(row.position.symbol) !== null);
  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  async function open() {
    const rows = chosen.map((position) => ({ position, id: draftId() }));
    let needed = false;
    if (builder) {
      const read = await venue.builderFeeApproval(owner);
      needed = !read.ok || compareDecimal(read.data.value, builder.feeBps) === -1;
    }
    setResults({});
    setApproval(needed ? { id: draftId(), done: false, answer: null } : null);
    setReview(rows);
  }
  async function confirm() {
    if (!review || sending.current || !priced) return;
    sending.current = true;
    setBusy(true);
    const out: Record<string, ActionResult> = { ...results };
    try {
      if (builder && approval && !approval.done) {
        const answer = await run(
          { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
          { actionKey: keys.builderApproval(owner, builder.address, builder.feeBps, undefined, approval.id) },
        );
        if (answer.kind !== 'outcome' || !answer.outcome.accepted) {
          // No close is sent before the approval it needs. A press again is the same approval until the venue answers it
          // definitely; after a definite no, a new one.
          setApproval({ id: answer.kind === 'outcome' ? draftId() : approval.id, done: false, answer });
          return;
        }
        setApproval({ ...approval, done: true, answer });
      }
      for (const row of review) {
        const p = row.position;
        const key = rowId(p);
        if (out[key] && !keepsDraft(out[key]!)) continue;
        const answer = await run({
          kind: 'place_order',
          symbol: p.symbol,
          side: p.side === 'long' ? 'sell' : 'buy',
          type: 'limit',
          amount: p.size,
          price: closeWorstPrice(p, tickOf(p.symbol)!),
          timeInForce: 'IOC',
          reduceOnly: true,
          clientOrderKey: keys.close(owner, p.symbol, row.id),
          builderFee: null,
        });
        out[key] = answer;
        setResults({ ...out });
      }
    } finally {
      sending.current = false;
      setBusy(false);
      onDone();
    }
  }
  function finish() {
    if (sending.current) return;
    setReview(null);
    setResults({});
    setPicked(new Set());
  }
  const done = review !== null && review.every((row) => results[rowId(row.position)] && !keepsDraft(results[rowId(row.position)]!));
  return (
    <>
      {positions.length === 0 ? (
        <p>{t('positionsNone')}</p>
      ) : (
        <>
          <ul className="lt-rows" data-testid="risk-venue-positions">
            {positions.map((p) => (
              <li key={rowId(p)} data-symbol={p.symbol}>
                <Checkbox checked={picked.has(rowId(p))} disabled={review !== null} onCheckedChange={() => toggle(rowId(p))}>
                  {t('positionRow', {
                    symbol: p.symbol,
                    side: t(p.side === 'long' ? 'sideLong' : 'sideShort'),
                    size: displayAmount(p.size),
                  })}
                </Checkbox>
              </li>
            ))}
          </ul>
          <div className="lt-actions">
            <Button tone="secondary" disabled={review !== null} onClick={() => setPicked(new Set(positions.map(rowId)))}>
              {t('reduceSelectAll')}
            </Button>
            <Button tone="secondary" disabled={review !== null || picked.size === 0} onClick={() => setPicked(new Set())}>
              {t('reduceSelectNone')}
            </Button>
            <span className="lt-hint" role="status">
              {t('reduceSelected', { count: String(chosen.length) })}
            </span>
          </div>
          <div className="lt-actions">
            <Button tone="primary" disabled={review !== null || chosen.length === 0} onClick={() => void open()}>
              {t('reduceButton')}
            </Button>
            {chosen.length === 0 ? <span className="lt-hint">{t('reduceNeedsSelection')}</span> : null}
          </div>
        </>
      )}
      {review && !signing ? (
        <section className="lt-stack" aria-label={t('venueCloseTitle')} data-testid="risk-venue-close">
          <h3>{t('venueCloseTitle')}</h3>
          <p className="lt-hint">{t('venueCloseIntro')}</p>
          {builder && approval && !approval.done ? (
            <div data-testid="risk-venue-approve">
              <p>{t('venueCloseApprove', { fee: builder.feeBps })}</p>
              {approval.answer ? <OutcomeLine result={approval.answer} owner={owner} /> : null}
            </div>
          ) : null}
          <ul className="lt-rows">
            {review.map(({ position: p }) => (
              <li key={rowId(p)} data-symbol={p.symbol}>
                {t('positionRow', { symbol: p.symbol, side: t(p.side === 'long' ? 'sideLong' : 'sideShort'), size: displayAmount(p.size) })}
                {results[rowId(p)] ? <OutcomeLine result={results[rowId(p)]!} owner={owner} /> : null}
              </li>
            ))}
          </ul>
          <div className="lt-actions">
            <Button tone="secondary" disabled={busy} onClick={finish}>
              {done ? t('cancelClose') : t('venueCloseKeep')}
            </Button>
            {done ? null : (
              <Button tone="primary" aria-busy={busy || undefined} disabled={busy || !priced} onClick={() => void confirm()}>
                {t('venueCloseConfirm', { count: String(review.length) })}
              </Button>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
