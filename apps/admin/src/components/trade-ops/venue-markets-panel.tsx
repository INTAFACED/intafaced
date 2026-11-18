'use client';

import { useState } from 'react';
import { Badge } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import {
  CHANGE_LABEL,
  checkDelistsAt,
  checkLimits,
  checkOpensAt,
  checkRouting,
  reasonReady,
  REASON_MIN,
  ROUTING_LABEL,
  VENUE_CODE_WORDS,
  VENUE_ROUTING_STATES,
  venueStatusText,
  type VenueChange,
  type VenueMarketRow,
  type VenueMarketsView,
  type VenueRoutingState,
} from '@/lib/trade-ops/venue-markets-model';
import { OutcomeNotice } from './outcome-notice';
import { Field, TwoPersonForm, type Refusal } from './two-person-form';

/**
 * The venue markets section of the Markets room (J-cex-spot-16): which markets of the outside venue INTAFACED shows, our
 * routing state, our largest routed order and a scheduled delisting, each beside the venue's own state and largest
 * order. Every change is a two-person request: founder A files it, a different founder approves it in Freezes &
 * approvals, then it is written here. Nothing here moves money or touches an open order.
 */

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_td]:align-top [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start';

type Written = { symbol: string; version: number; proposerId: string; approverId: string };

const routingText = (r: VenueRoutingState) => ROUTING_LABEL[r];
const refusal = (c: { ok: false; code: string; message: string }): Refusal => ({ code: c.code, message: c.message });

function MarketsTable({ view }: { view: VenueMarketsView }) {
  if (view.markets.length === 0)
    return (
      <p className="text-sm text-fg-2" data-venue="none">
        The venue lists no market.
      </p>
    );
  return (
    <table className={TABLE} data-venue="markets">
      <thead>
        <tr>
          <th scope="col">Venue market</th>
          <th scope="col">Shown on INTAFACED</th>
          <th scope="col">Our routing</th>
          <th scope="col">Venue&apos;s own state</th>
          <th scope="col">Our largest routed order</th>
          <th scope="col">Venue&apos;s largest order</th>
          <th scope="col">Delisting notice</th>
        </tr>
      </thead>
      <tbody>
        {view.markets.map((m) => (
          <tr
            key={m.symbol}
            data-venue-market={m.symbol}
            data-shown={m.listing ? 'yes' : 'no'}
            data-routing={m.listing?.routing ?? ''}
            data-venue-status={m.venue.status ?? ''}
          >
            <td>
              <span className="if-num">{m.symbol}</span>
              {view.test ? (
                <Badge tone="warn" density="dense" className="ms-2" data-test-label="">
                  TEST
                </Badge>
              ) : null}
              <span className="block text-xs text-fg-2">{m.kind ?? 'kind not reported'}</span>
            </td>
            <td data-cell="listing">
              {m.listing ? (
                <>
                  <span className="block">
                    Shown · v{m.listing.version}
                    {m.listing.delisted ? ' · delisted' : m.listing.open ? ' · open' : ' · before its opening time'}
                  </span>
                  <span className="block text-xs text-fg-2">
                    Opens at <span className="if-num">{m.listing.opensAt}</span>
                  </span>
                  <span className="block text-xs text-fg-2" data-cell="delists-at">
                    {m.listing.delistsAt ? (
                      <>
                        Delists at <span className="if-num">{m.listing.delistsAt}</span>
                      </>
                    ) : (
                      'No delisting scheduled'
                    )}
                  </span>
                  <span className="block text-xs text-fg-2">
                    Proposed by {m.listing.proposerId} · approved by {m.listing.approverId}
                  </span>
                </>
              ) : (
                <span className="text-fg-2">Not shown: no approved listing</span>
              )}
            </td>
            <td data-cell="routing">{m.listing ? routingText(m.listing.routing) : <span className="text-fg-2">Not routed</span>}</td>
            <td data-cell="venue-status">{m.venue.listed ? venueStatusText(m.venue.status) : 'No longer listed by the venue'}</td>
            <td data-cell="limits">
              {m.limits ? (
                <>
                  <span className="if-num block">
                    {m.limits.maxOrderQty} size · {m.limits.maxOrderNotional} notional
                  </span>
                  <span className="block text-xs text-fg-2" data-cell="limits-version" data-version={m.limits.version}>
                    v{m.limits.version} · proposed by {m.limits.proposerId} · approved by {m.limits.approverId}
                  </span>
                </>
              ) : (
                <span className="text-fg-2">None of ours: the venue&apos;s own applies</span>
              )}
            </td>
            <td data-cell="venue-limits" className="if-num">
              {m.venue.maxOrderQty === null || m.venue.maxOrderNotional === null
                ? 'Not reported by the venue'
                : `${m.venue.maxOrderQty} size · ${m.venue.maxOrderNotional} notional`}
            </td>
            <td data-cell="notice">
              {m.delistingNotice ? (
                <>
                  <span className="block">
                    One notice for <span className="if-num">{m.delistingNotice.delistsAt}</span>
                  </span>
                  <span className="block text-xs text-fg-2">
                    {m.delistingNotice.publishedAt ? `Sent at ${m.delistingNotice.publishedAt}` : 'Waiting to be sent'}
                  </span>
                </>
              ) : (
                <span className="text-fg-2">None</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MarketSelect({ markets, value, onChange }: { markets: readonly VenueMarketRow[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>Market</span>
      <select className="adm-input" aria-label="Market" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {markets.map((m) => (
          <option key={m.symbol} value={m.symbol}>
            {m.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One change of one market as a two-person request. */
function ChangeForm({
  change,
  view,
  onWritten,
}: {
  change: VenueChange;
  view: VenueMarketsView;
  onWritten: (outcome: Outcome<unknown>) => void;
}) {
  const [symbol, setSymbol] = useState('');
  const [reason, setReason] = useState('');
  const [time, setTime] = useState('');
  const [routing, setRouting] = useState<string>('');
  const [qty, setQty] = useState('');
  const [notional, setNotional] = useState('');
  const row = view.markets.find((m) => m.symbol === symbol);

  const fields = (): Record<string, string> =>
    change === 'listing'
      ? { opensAt: time }
      : change === 'delisting'
        ? { delistsAt: time }
        : change === 'routing'
          ? { routing }
          : { maxOrderQty: qty, maxOrderNotional: notional };

  const check = (): Refusal | null => {
    if (!row) return { code: 'trade.venue_market_unknown', message: 'Choose a venue market.' };
    if ((change === 'listing' || change === 'limits') && !row.venue.listed)
      return { code: 'trade.venue_market_unknown', message: VENUE_CODE_WORDS['trade.venue_market_unknown']! };
    if (change !== 'listing' && !row.listing)
      return { code: 'trade.venue_listing_missing', message: VENUE_CODE_WORDS['trade.venue_listing_missing']! };
    if (change === 'listing') {
      const c = checkOpensAt(time);
      if (!c.ok) return refusal(c);
    } else if (change === 'delisting') {
      const c = checkDelistsAt(time);
      if (!c.ok) return refusal(c);
    } else if (change === 'routing') {
      const c = checkRouting(routing);
      if (!c.ok) return refusal(c);
    } else {
      const c = checkLimits({ maxOrderQty: qty, maxOrderNotional: notional }, row.venue);
      if (!c.ok) return refusal(c);
    }
    if (!reasonReady(reason))
      return {
        code: 'trade_ops.reason_required',
        message: `Write the reason (at least ${REASON_MIN} characters). It is kept in the audit.`,
      };
    return null;
  };

  const version = change === 'limits' ? (row?.limits?.version ?? 0) : (row?.listing?.version ?? 0);
  const body = () => ({ change, symbol, reason, ...fields() });
  const title =
    change === 'listing'
      ? 'List a venue market'
      : change === 'routing'
        ? 'Set a routing state'
        : change === 'limits'
          ? 'Edit our routed-order limits'
          : 'Schedule a delisting';
  const consequence =
    change === 'limits'
      ? 'Our largest routed order on this market becomes the new version. Open venue orders stay as they are; nothing moves or is cancelled. The approval is used up.'
      : change === 'routing'
        ? 'New orders routed through INTAFACED follow this state. Nothing is cancelled and open venue orders stay as they are; cancels always work. The approval is used up.'
        : change === 'delisting'
          ? 'Customers get one dated notice; new opens refuse after the date. Nothing is cancelled. The approval is used up.'
          : 'The market shows on INTAFACED from its opening time. The approval is used up.';

  return (
    <section data-venue-form={change} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{CHANGE_LABEL[change]}</h3>
      <TwoPersonForm
        room="venue-markets"
        label={title}
        proposeLabel="Ask a second founder to approve"
        applyLabel="Apply the approved change"
        confirmTitle={`${title}: ${symbol || 'the market'}?`}
        confirmLabel="Write change"
        consequence={consequence}
        check={check}
        proposeBody={() => ({ action: 'propose', ...body() })}
        applyBody={(approvalId) => ({ action: 'apply', ...body(), approvalId })}
        canApply={row !== undefined}
        onWritten={onWritten}
      >
        <div className="flex flex-wrap items-end gap-3">
          <MarketSelect markets={view.markets} value={symbol} onChange={setSymbol} />
          {change === 'listing' ? <Field label="Opens at (ISO time with zone)" value={time} onChange={setTime} /> : null}
          {change === 'delisting' ? <Field label="Delists at (ISO time with zone)" value={time} onChange={setTime} /> : null}
          {change === 'routing' ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>Routing state</span>
              <select className="adm-input" aria-label="Routing state" value={routing} onChange={(e) => setRouting(e.target.value)}>
                <option value="">Choose…</option>
                {VENUE_ROUTING_STATES.map((r) => (
                  <option key={r} value={r}>
                    {ROUTING_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {change === 'limits' ? (
            <>
              <Field label="Largest order size" value={qty} onChange={setQty} inputMode="decimal" />
              <Field label="Largest order notional" value={notional} onChange={setNotional} inputMode="decimal" />
            </>
          ) : null}
        </div>
        <Field label="Reason (12 to 500 characters, kept in the audit)" value={reason} onChange={setReason} wide />
        <p className="text-xs text-fg-2">
          {row
            ? `This proposes v${version + 1} of ${row.symbol}'s ${change === 'limits' ? 'limits' : 'listing'}, after v${version}.`
            : 'Choose a market to see the version this proposes.'}
          {change === 'limits' && row
            ? ` The venue's own largest order: ${
                row.venue.maxOrderQty === null || row.venue.maxOrderNotional === null
                  ? 'not reported'
                  : `${row.venue.maxOrderQty} size, ${row.venue.maxOrderNotional} notional`
              }; ours is never above it.`
            : ''}
        </p>
      </TwoPersonForm>
    </section>
  );
}

export function VenueMarketsPanel({ initial }: { initial: VenueMarketsView }) {
  const [view, setView] = useState(initial);
  const [written, setWritten] = useState<Written | null>(null);
  const [reread, setReread] = useState<Outcome<VenueMarketsView> | null>(null);

  async function onWritten(outcome: Outcome<unknown>) {
    if (outcome.kind === 'ok') setWritten(outcome.data as Written);
    const next = await tradeOpsAction<VenueMarketsView>('venue-markets', { action: 'read' });
    setReread(next.kind === 'ok' ? null : next);
    if (next.kind === 'ok') setView(next.data);
  }

  return (
    <div className="flex flex-col gap-4" data-venue="desk" data-venue-id={view.venueId}>
      <p className="text-sm text-fg-2">
        Venue <span className="if-num">{view.venueId}</span>
        {view.test ? (
          <Badge tone="warn" density="dense" className="ms-2" data-test-label="">
            TEST
          </Badge>
        ) : null}{' '}
        · read at <span className="if-num">{view.asOf}</span>. The venue&apos;s own state and largest order are its word, shown beside ours
        and never replaced. A market shows on INTAFACED only once two founders approve its listing.
      </p>
      <MarketsTable view={view} />
      {written ? (
        <p
          role="status"
          className="text-sm"
          data-venue="written"
          data-symbol={written.symbol}
          data-version={written.version}
          data-approver={written.approverId}
        >
          v{written.version} of {written.symbol} written · proposed by {written.proposerId} · approved by {written.approverId}.
        </p>
      ) : null}
      {reread ? <OutcomeNotice outcome={reread} /> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        {(['listing', 'routing', 'limits', 'delisting'] as const).map((c) => (
          <ChangeForm key={c} change={c} view={view} onWritten={(o) => void onWritten(o)} />
        ))}
      </div>
    </div>
  );
}
