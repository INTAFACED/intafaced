import { useState } from 'react';
import { navigate } from '../../../app/location';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { uiCopy } from '../../../shared/ui-copy';
import { displayAmount, parseAmount } from '../../../shared/money';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  draftId,
  keys,
  leverageTimes,
  sumDecimals,
  type MarketVenue,
  type OrderIntent,
  type RouteCost,
  type RoutePreview,
  type VenueMarginMode,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  AsOfLine,
  Known,
  OutcomeLine,
  TestMark,
  VENUE_POLL_MS,
  useAsOfText,
  useVenueApi,
  type ActionResult,
  type RunAction,
} from '../../../features/trade/venue/VenueKit';
import { futuresRoutesCopy } from './routes-copy';
import { approvalAtConfirm, approvalState } from './venue-routes-logic';

/**
 * ROUTING OVER THE VENUES THE PERSON CAN SIGN FOR (J-derivatives-28). Shown only when the deployment has more than one
 * venue (`status.routes`). Every figure is the venue's own, labelled TEST on a TEST venue; a fee a venue doesn't publish
 * reads "not known".
 *
 *   · The venues strip: each venue that lists the market with its best bid and ask, the depth it shows, its fees, our
 *     builder fee, whether the person can sign there ("connect to use" when not), and its health (down: since when, why).
 *   · The routed Review: the venue chosen for this order, its expected fill and fees, why that venue, and the others.
 *     Confirm asks for our builder-fee approval on that venue first when it has none (one signature, once per venue),
 *     then the order: one signature, sent once to that venue under the ticket's client id.
 */

const depthOf = (levels: readonly { amount: string }[]) => sumDecimals(levels.map((l) => l.amount));

function useHealthText() {
  const { t } = futuresRoutesCopy.useCopy();
  const asOf = useAsOfText();
  return (v: MarketVenue) =>
    v.health.state === 'up'
      ? t('Venue up')
      : t('Venue down since', { since: asOf(v.health.since), reason: v.health.reason ?? t('No reason given') });
}

export function useMarketVenues(owner: string, symbol: string, side: 'buy' | 'sell') {
  const venue = useVenueApi();
  return usePolled((signal) => venue.marketVenues(symbol, owner, side, signal), `routes:${owner}:${symbol}:${side}`, VENUE_POLL_MS);
}

/** The venues strip of one market (J-derivatives-28 #1, #4). */
export function VenueRoutes({
  symbol,
  owner,
  side,
  run,
  leverage,
}: {
  symbol: string;
  owner: string;
  side: 'buy' | 'sell';
  run: RunAction;
  /** The leverage the person set on the primary venue, which "Set here" signs on another venue (one signature each). */
  leverage: { leverageBps: number; marginMode: VenueMarginMode } | null;
}) {
  const { t } = futuresRoutesCopy.useCopy();
  const read = useMarketVenues(owner, symbol, side);
  const health = useHealthText();
  const venues = read.data?.venues ?? [];
  return (
    <section className="lt-panel" aria-label={t('Venues')} data-testid="venue-routes">
      <h2 className="lt-panel-title">{t('Venues')}</h2>
      <p className="lt-quiet">{t('Venues lead')}</p>
      {read.failure ? (
        <p className="lt-callout lt-callout-bad" role="alert" data-testid="venue-routes-error">
          {t('Venues read failed', { detail: read.failure.message })}{' '}
          <Button tone="secondary" onClick={read.reload}>
            {t('Read again')}
          </Button>
        </p>
      ) : null}
      {!read.data && !read.failure ? <p className="lt-quiet">{t('Reading venues')}</p> : null}
      {read.data && venues.every((v) => v.listed === false) ? (
        <p data-testid="venue-routes-empty">{t('No venue lists', { symbol })}</p>
      ) : null}
      {venues.length > 0 ? (
        <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Venues')}>
          <table className="lt-table lt-table-dense">
            <thead>
              <tr>
                <th scope="col">{t('Venue')}</th>
                <th scope="col">{t('State')}</th>
                <th scope="col">{t('Best bid')}</th>
                <th scope="col">{t('Best ask')}</th>
                <th scope="col">{t('Depth shown')}</th>
                <th scope="col">{t('Venue fees')}</th>
                <th scope="col">{t('Our builder fee')}</th>
                <th scope="col">{t('Your account')}</th>
              </tr>
            </thead>
            <tbody>
              {venues.map((v, i) => (
                <tr key={v.venueId ?? `unreachable-${i}`} data-venue={v.venueId ?? ''} data-state={v.health.state} data-account={v.account}>
                  <td data-cell="venue">
                    {v.displayName ?? t('Venue not reached')} <TestMark test={v.test} />
                  </td>
                  <td data-cell="state">{health(v)}</td>
                  {v.listed === false ? (
                    <td colSpan={6} data-cell="not-listed">
                      {t('Not listed here', { symbol })}
                    </td>
                  ) : (
                    <>
                      <td className="lt-num" data-cell="bid">
                        {v.book?.value.bids[0]
                          ? t('Level', {
                              price: displayAmount(v.book.value.bids[0].price),
                              amount: displayAmount(v.book.value.bids[0].amount),
                            })
                          : t('None')}
                      </td>
                      <td className="lt-num" data-cell="ask">
                        {v.book?.value.asks[0]
                          ? t('Level', {
                              price: displayAmount(v.book.value.asks[0].price),
                              amount: displayAmount(v.book.value.asks[0].amount),
                            })
                          : t('None')}
                      </td>
                      <td className="lt-num" data-cell="depth">
                        {v.book
                          ? t('Depth', {
                              bids: displayAmount(depthOf(v.book.value.bids)),
                              asks: displayAmount(depthOf(v.book.value.asks)),
                              base: v.market?.baseAsset ?? '',
                            })
                          : t('None')}
                      </td>
                      <td data-cell="fees">
                        {v.market ? (
                          <>
                            <span data-fee="maker">
                              {t('Maker')} <Known value={v.market.makerFeeBps} render={(x) => t('Bps', { bps: displayAmount(x) })} />
                            </span>
                            {' · '}
                            <span data-fee="taker">
                              {t('Taker')} <Known value={v.market.takerFeeBps} render={(x) => t('Bps', { bps: displayAmount(x) })} />
                            </span>
                          </>
                        ) : (
                          t('None')
                        )}
                      </td>
                      <td data-cell="builder-fee">
                        {!v.builderFee
                          ? t('None')
                          : !v.builderFee.published
                            ? t('Builder fee blank')
                            : v.builderFee.carries
                              ? t('Bps', { bps: displayAmount(v.builderFee.feeBps) })
                              : t('Builder none spot buy')}
                      </td>
                      <td data-cell="account">
                        {v.account === 'signable' ? (
                          <>
                            {t('You can sign here')}
                            {v.venueId && v.market?.kind === 'perpetual' ? (
                              <VenueLeverage venueId={v.venueId} symbol={symbol} owner={owner} run={run} leverage={leverage} />
                            ) : null}
                          </>
                        ) : v.account === 'connect' ? (
                          <>
                            {t('Connect to use')}{' '}
                            <a
                              href="/wallet"
                              onClick={(e) => {
                                e.preventDefault();
                                navigate('/wallet');
                              }}
                            >
                              {t('How to connect')}
                            </a>
                          </>
                        ) : (
                          t('Account not read')
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <AsOfLine asOf={read.data?.at ?? null} />
    </section>
  );
}

/** One venue's leverage setting on a perpetual, and the one signature that sets it there. */
function VenueLeverage({
  venueId,
  symbol,
  owner,
  run,
  leverage,
}: {
  venueId: string;
  symbol: string;
  owner: string;
  run: RunAction;
  leverage: { leverageBps: number; marginMode: VenueMarginMode } | null;
}) {
  const { t } = futuresRoutesCopy.useCopy();
  const venue = useVenueApi();
  const set = usePolled((signal) => venue.leverage(owner, symbol, signal, venueId), `lev:${venueId}:${owner}:${symbol}`, VENUE_POLL_MS);
  const [result, setResult] = useState<ActionResult | null>(null);
  const now = set.data?.value ?? null;
  const same = now && leverage && now.leverageBps === leverage.leverageBps && now.marginMode === leverage.marginMode;
  async function sign() {
    if (!leverage) return;
    setResult(
      await run(
        { kind: 'update_leverage', symbol, leverageBps: leverage.leverageBps, marginMode: leverage.marginMode },
        { actionKey: keys.leverage(owner, symbol, leverage.marginMode, leverage.leverageBps, `route-${venueId}`), venueId },
      ),
    );
    set.reload();
  }
  return (
    <span data-testid="venue-route-leverage" data-venue={venueId}>
      {' · '}
      {now
        ? t('Leverage here', { times: String(leverageTimes(now.leverageBps)), mode: now.marginMode })
        : set.data
          ? t('Leverage not set here')
          : ''}
      {!same && leverage ? (
        <>
          {' '}
          <Button tone="secondary" onClick={() => void sign()}>
            {t('Set leverage here', { times: String(leverageTimes(leverage.leverageBps)), mode: leverage.marginMode })}
          </Button>
        </>
      ) : null}
      <OutcomeLine result={result} owner={owner} venueId={venueId} />
    </span>
  );
}

/** "Why this venue", in words, from the router's reason and the figures it ranked on (J-derivatives-28 #2). */
type RoutesT = ReturnType<typeof futuresRoutesCopy.useCopy>['t'];

export function routeWhy(t: RoutesT, route: RoutePreview): string {
  const chosen = route.chosen;
  if (!chosen) return t('Why none');
  const next = route.others[0];
  const quote = route.quoteAsset ?? '';
  const total = (c: RouteCost) => `${displayAmount(c.total)} ${quote}`;
  const shortAtShown =
    next && next.shownBest && parseAmount(next.shownBest.amount) < parseAmount(route.amount)
      ? t('Why shown depth', {
          venue: next.displayName,
          shown: displayAmount(next.shownBest.amount),
          size: displayAmount(route.amount),
          price: displayAmount(next.shownBest.price),
        })
      : '';
  let why: string;
  switch (route.reason) {
    case 'only_venue':
      why = t('Why only', { venue: chosen.displayName });
      break;
    case 'fills_whole':
      why = t('Why fills whole', { venue: chosen.displayName });
      break;
    case 'fills_most':
      why = t('Why fills most', { venue: chosen.displayName, fills: displayAmount(chosen.cost.fillsNow ?? '0') });
      break;
    case 'lowest_cost':
      why =
        route.side === 'buy'
          ? t('Why lowest cost', {
              venue: chosen.displayName,
              total: total(chosen.cost),
              other: next?.displayName ?? '',
              otherTotal: next ? total(next) : '',
            })
          : t('Why most proceeds', {
              venue: chosen.displayName,
              total: total(chosen.cost),
              other: next?.displayName ?? '',
              otherTotal: next ? total(next) : '',
            });
      break;
    default:
      why = t('Why tie', { venue: chosen.displayName });
  }
  const unknown = chosen.cost.unknownFees.length > 0 ? ` ${t('Why fee not known')}` : '';
  return `${shortAtShown}${shortAtShown ? ' ' : ''}${why}${unknown}`;
}

type Step = 'review' | 'approval' | 'declined';

/**
 * Brings a refusal into view inside the dialog as it appears, so the person who pressed Approve reads why it failed rather
 * than a line cut off below the dialog's fold (J-derivatives-30 #5).
 */
const reveal = (el: HTMLElement | null) => el?.scrollIntoView?.({ block: 'nearest' });

/**
 * The venue's own reason when it refused our approval because the wallet already holds the most active builder approvals
 * it allows (J-derivatives-30 #5), at prepare or at submit; null for any other answer.
 */
function approvalLimit(result: ActionResult | null): string | null {
  if (result?.kind === 'refused' && result.code === 'trade.venue.builder_approval_limit') return result.message;
  if (result?.kind === 'outcome' && !result.outcome.accepted && result.outcome.refusal.code === 'builder_approval_limit')
    return result.outcome.refusal.detail;
  return null;
}

/** The routed Review of one order: the venue chosen, why, and Confirm (approval first where needed, then the order). */
export function RoutedReview({
  title,
  route,
  intent,
  status,
  owner,
  run,
  resend,
  confirmLabel,
  onSent,
  onClose,
}: {
  title: string;
  route: RoutePreview;
  intent: OrderIntent;
  status: VenueUp;
  owner: string;
  run: RunAction;
  resend: (intent: OrderIntent, opts: { venueId?: string }) => Promise<ActionResult>;
  confirmLabel: string;
  onSent: (result: ActionResult) => void;
  onClose: () => void;
}) {
  const { t } = futuresRoutesCopy.useCopy();
  const venue = useVenueApi();
  const chosen = route.chosen;
  const p = chosen?.preview.value ?? null;
  const carries = p ? !(p.builderFee.known && /^0(\.0+)?$/.test(p.builderFee.value.amount)) : false;
  const approval = usePolled(
    (signal) => (chosen && carries ? venue.builderFeeApproval(owner, signal, chosen.venueId) : Promise.resolve(null)),
    `route-approval:${chosen?.venueId ?? ''}:${owner}`,
    VENUE_POLL_MS,
  );
  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<ActionResult | null>(null);
  // The draft this review's builder approval is asked under: a new review after a revoke asks a new one (J-derivatives-30 #4).
  const [approvalDraft] = useState(() => draftId());
  const [result, setResult] = useState<ActionResult | null>(null);
  const fee = status.builder?.feeBps ?? null;
  const approvedAmount = approval.data && 'value' in approval.data ? approval.data.value : null;
  const approvalNow = approvalState(carries, fee, { approved: approvedAmount, failed: approval.failure !== null });
  const approved = approvalNow === 'not_needed' || approvalNow === 'approved';

  async function order() {
    if (!chosen) return;
    const answer = await run(intent, { venueId: chosen.venueId });
    setResult(answer);
    onSent(answer);
  }

  async function confirm() {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      // The poll's answer may be a read that failed or is older than an approval just signed: Confirm asks the venue once
      // more before it asks the person to sign an approval they may already hold.
      if (!approved) {
        const now = await approvalAtConfirm(carries, fee, approvalNow, () => venue.builderFeeApproval(owner, undefined, chosen.venueId));
        approval.reload();
        if (now !== 'approved' && now !== 'not_needed') {
          setStep('approval');
          return;
        }
      }
      await order();
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!chosen || !status.builder || busy) return;
    setBusy(true);
    try {
      const answer = await run(
        { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
        {
          actionKey: keys.builderApproval(owner, status.builder.address, status.builder.feeBps, chosen.venueId, approvalDraft),
          venueId: chosen.venueId,
        },
      );
      setApproving(answer);
      approval.reload();
      if (answer.kind === 'outcome' && answer.outcome.accepted) {
        setStep('review');
        await order();
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendAgain() {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      const answer = await resend(intent, { venueId: chosen.venueId });
      setResult(answer);
      onSent(answer);
    } finally {
      setBusy(false);
    }
  }

  const filled = result?.kind === 'outcome' && result.outcome.accepted ? result.outcome : null;
  const { t: ui, languageFor: uiLanguage } = uiCopy.useCopy();
  return (
    <Sheet open title={title} onClose={onClose} closeLabel={ui('closeDialog')} closeLang={uiLanguage('closeDialog')}>
      <div data-testid="venue-route-review" className="lt-stack">
        {!chosen ? (
          <div role="alert" data-testid="venue-route-none">
            <p className="lt-callout lt-callout-bad">{t('Why none')}</p>
            <ul>
              {route.excluded.map((e, i) => (
                <li key={e.venueId ?? i} data-venue={e.venueId ?? ''} data-code={e.code}>
                  {t('Excluded', { venue: e.displayName ?? t('Venue not reached'), detail: e.detail })}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <TestMark test={chosen.test} />
            <dl className="lt-kv">
              <div>
                <dt>{t('Routed to')}</dt>
                <dd data-line="route-venue" data-venue={chosen.venueId}>
                  {chosen.displayName}
                </dd>
              </div>
              <div>
                <dt>{t('Expected fill')}</dt>
                <dd className="lt-num" data-line="route-fill">
                  {chosen.cost.fillsNow === null
                    ? t('Not known')
                    : chosen.cost.averagePrice === null
                      ? t('Fills none now')
                      : t('Fills at', {
                          fills: displayAmount(chosen.cost.fillsNow),
                          size: displayAmount(route.amount),
                          price: displayAmount(chosen.cost.averagePrice),
                        })}
                </dd>
              </div>
              <div>
                <dt>{t('Venue fee')}</dt>
                <dd className="lt-num" data-line="venue-fee">
                  <Known value={p!.venueFee.known ? { known: true, value: p!.venueFee.value.amount } : { known: false }} />{' '}
                  {p!.venueFee.known ? p!.venueFee.value.asset : ''}
                </dd>
              </div>
              <div>
                <dt>{t('Our builder fee')}</dt>
                <dd className="lt-num" data-line="builder-fee">
                  {!carries ? (
                    t('Builder none spot buy')
                  ) : (
                    <>
                      <Known value={p!.builderFee.known ? { known: true, value: p!.builderFee.value.amount } : { known: false }} />{' '}
                      {p!.builderFee.known ? p!.builderFee.value.asset : ''}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{route.side === 'buy' ? t('Expected cost') : t('Expected proceeds')}</dt>
                <dd className="lt-num" data-line="route-total">
                  {displayAmount(chosen.cost.total)} {route.quoteAsset}
                  {chosen.cost.unknownFees.length > 0 ? ` (${t('Known fees only')})` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('Why this venue')}</dt>
                <dd data-line="route-why">{routeWhy(t, route)}</dd>
              </div>
              <div>
                <dt>{t('Client id held')}</dt>
                <dd className="lt-num" data-line="client-id">
                  {intent.clientOrderKey}
                </dd>
              </div>
            </dl>
            {route.others.length > 0 || route.excluded.length > 0 ? (
              <ul aria-label={t('Other venues')} data-testid="venue-route-others">
                {route.others.map((o) => (
                  <li key={o.venueId} data-venue={o.venueId}>
                    {t('Other venue', {
                      venue: o.displayName,
                      fills: o.fillsNow === null ? t('Not known') : displayAmount(o.fillsNow),
                      size: displayAmount(route.amount),
                      total: `${displayAmount(o.total)} ${route.quoteAsset ?? ''}`,
                    })}
                  </li>
                ))}
                {route.excluded.map((e, i) => (
                  <li key={e.venueId ?? `x${i}`} data-venue={e.venueId ?? ''} data-code={e.code}>
                    {t('Excluded', { venue: e.displayName ?? t('Venue not reached'), detail: e.detail })}
                  </li>
                ))}
              </ul>
            ) : null}
            <AsOfLine asOf={chosen.preview.asOf} />
          </>
        )}
        {step === 'approval' && chosen && status.builder ? (
          <section role="dialog" aria-label={t('Approve builder fee')} data-testid="venue-route-approval" className="lt-stack">
            <h3>{t('Approve builder fee')}</h3>
            <p data-line="approval-words">
              {t('Approval words', { venue: chosen.displayName, bps: displayAmount(status.builder.feeBps) })}
            </p>
            <Button tone="primary" disabled={busy} onClick={() => void approve()}>
              {t('Approve in wallet')}
            </Button>{' '}
            <Button
              tone="secondary"
              disabled={busy}
              onClick={() => {
                setStep('declined');
              }}
            >
              {t('Decline')}
            </Button>
            {approvalLimit(approving) ? (
              <p className="lt-callout lt-callout-bad" role="alert" data-testid="venue-route-approval-limit" ref={reveal}>
                {t('Approval limit words', { venue: chosen.displayName, detail: approvalLimit(approving) ?? '' })}
              </p>
            ) : (
              <OutcomeLine result={approving} owner={owner} venueId={chosen.venueId} />
            )}
          </section>
        ) : null}
        {step === 'declined' && chosen ? (
          <p className="lt-callout lt-callout-bad" role="alert" data-testid="venue-route-declined">
            {t('Declined words', { venue: chosen.displayName })}
          </p>
        ) : null}
        {chosen ? (
          <Button
            tone="primary"
            disabled={
              busy ||
              step === 'approval' ||
              approvalNow === 'reading' ||
              (result !== null && result.kind !== 'rejected' && result.kind !== 'wallet_failed')
            }
            onClick={() => {
              setStep('review');
              void confirm();
            }}
          >
            {confirmLabel}
          </Button>
        ) : null}{' '}
        {result?.kind === 'unknown' ? (
          <Button tone="secondary" disabled={busy} onClick={() => void sendAgain()}>
            {t('Send again')}
          </Button>
        ) : null}{' '}
        <Button tone="secondary" onClick={onClose}>
          {t('Close review')}
        </Button>
        <OutcomeLine result={result} owner={owner} {...(chosen ? { venueId: chosen.venueId } : {})} />
        {filled && chosen ? (
          <p data-testid="venue-route-filled" data-line="route-outcome">
            {t('Sent to venue', { venue: chosen.displayName, ref: filled.venueRef ?? filled.order?.venueOrderId ?? t('Not known') })}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
