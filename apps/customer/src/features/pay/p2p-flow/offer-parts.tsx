import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { navigate } from '../../../app/location';
import type { PersonalPayApi } from '../pay-api';
import type { BoardQuery, Offer, OfferPage, Reputation } from '../schemas';
import { payCopy } from '../copy';
import { offerCopy } from '../p2p-offer-copy';
import { p2pDepth } from '../personal/p2p-depth-copy';
import { myAdsCopy } from '../personal/p2p-my-ads-copy';
import { settlementCopy } from '../personal/settlement-copy';
import { makerSummary, splitDuration } from '../personal/p2p-model';
import { windowParts } from '../personal/Settlement';
import type { TraderRecords } from '../personal/Trader';
import { ordinaryClick, useCurrentNavigation, type P2PReturn } from '../p2p-return';
import { useBoardPages } from '../p2p-offers-state';
import { Amount, Failure, Time } from './parts';

/**
 * Kit views of the offer parts My offers shares with the board (`../P2POffers.tsx`, `../personal/Trader.tsx`,
 * `../personal/Settlement.tsx`, `../personal/p2p-my-ads.tsx`, `../p2p-return.tsx`): the same words, ids and handlers.
 */

/** The price line: fixed, or the reference factor with the reference price it floats on. */
export function OfferPrice({ offer }: { offer: Offer }) {
  const { Copy, t } = offerCopy.useCopy();
  return (
    <div data-testid="p2p-offer-price">
      {offer.priceType === 'float' ? (
        <>
          <span className="lt-hint">
            <Copy k="referenceFactor" />
          </span>
          <Amount value={offer.price} unit={t('multiplier')} label={t('referenceFactor')} />
          {offer.referencePrice ? (
            <span className="lt-hint">
              <Copy k="referencePrice" />{' '}
              <Amount value={offer.referencePrice} unit={`${offer.fiatCurrency} / ${offer.asset}`} label={t('referencePrice')} />
            </span>
          ) : offer.referencePrice === null ? (
            <span className="lt-hint" data-testid="p2p-offer-needs-feed">
              <Copy k="needsFeed" params={{ fiat: offer.fiatCurrency, asset: offer.asset }} />
            </span>
          ) : (
            <span className="lt-hint">
              <Copy k="unresolvedPrice" params={{ fiat: offer.fiatCurrency, asset: offer.asset }} />
            </span>
          )}
        </>
      ) : (
        <>
          <Amount value={offer.price} unit={`${offer.fiatCurrency} / ${offer.asset}`} label={payCopy.t('price')} />
          <span className="lt-hint">{t('fixed')}</span>
        </>
      )}
    </div>
  );
}

/** The side from the reader's own seat: what they would do on a stranger's offer, or what they are doing on their own. */
export function OfferSide({ offer, own }: { offer: Offer; own: boolean }) {
  const { t } = p2pDepth.useCopy();
  const key = own ? (offer.side === 'sell' ? 'ownSell' : 'ownBuy') : offer.side === 'sell' ? 'sideBuyFrom' : 'sideSellTo';
  return <>{t(key, { asset: offer.asset })}</>;
}

export function OfferLimits({ offer }: { offer: Offer }) {
  return (
    <span>
      <Amount value={offer.minAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
      <span>–</span>
      <Amount value={offer.maxAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
    </span>
  );
}

/** `OfferSettlement`: each non-instant method's longest window, and the seller's consent. */
export function OfferSettlement({ offer, label }: { offer: Offer; label: (methodId: string) => string }) {
  const { t } = settlementCopy.useCopy();
  const windowText = (seconds: number) => {
    const { unit, count } = windowParts(seconds);
    return t(unit, { count: String(count) });
  };
  const slow = offer.nonInstantMethods ?? [];
  if (slow.length === 0) return null;
  return (
    <span data-testid="offer-settlement">
      {slow.map((entry) => (
        <span key={entry.methodId} className="lt-hint">
          {entry.windowSeconds === null
            ? t('nonInstantBlank', { method: label(entry.methodId) })
            : t('nonInstant', { method: label(entry.methodId), window: windowText(entry.windowSeconds) })}
        </span>
      ))}
      {offer.acceptsNonInstant ? <span className="lt-hint">{t('consent')}</span> : null}
    </span>
  );
}

/** A details row for an ad's non-instant methods, or none when they are all instant. */
export const settlementRow = (offer: Offer): [string, ReactNode][] =>
  offer.nonInstantMethods?.length ? [[settlementCopy.t('label'), <OfferSettlement offer={offer} label={(methodId) => methodId} />]] : [];

/** "@handle" when identity gave one, otherwise "Member". Never the account id. */
export function TraderName({ record }: { record: ApiResult<Reputation> | null | undefined }) {
  const { t } = p2pDepth.useCopy();
  if (record === undefined) return <span aria-busy="true" />;
  const handle = record?.ok ? record.data.handle : null;
  if (handle) return <span lang="zxx">{`@${handle}`}</span>;
  if (record?.ok && record.data.profile?.status === 'absent')
    return (
      <span>
        <span aria-hidden="true">—</span> <small className="lt-hint">{t('traderNoHandle')}</small>
      </span>
    );
  return <span>{t('traderUnnamed')}</span>;
}

/** Orders, completion rate and average release time, exactly as returned. */
export function TraderSummary({ record }: { record: ApiResult<Reputation> | null | undefined }) {
  const { t, requestedLocale } = p2pDepth.useCopy();
  if (!record) return null;
  if (!record.ok) return <span className="lt-hint">{t('traderRecordOff')}</span>;
  const summary = makerSummary(record.data);
  if (summary.kind === 'new') return <span className="lt-hint">{t('traderNew')}</span>;
  const n = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 }).format(summary.orders);
  const orders = t(new Intl.PluralRules(requestedLocale).select(summary.orders) === 'one' ? 'traderOrdersOne' : 'traderOrdersMany', { n });
  if (summary.kind === 'unfinished') return <span className="lt-hint">{t('traderRecordOpen', { orders })}</span>;
  const rate = new Intl.NumberFormat(requestedLocale, { style: 'percent', maximumFractionDigits: 1 }).format(summary.completionRate);
  if (summary.releaseSecs === null) return <span className="lt-hint">{t('traderRecord', { orders, rate })}</span>;
  const parts = splitDuration(summary.releaseSecs);
  const time =
    parts.unit === 'seconds'
      ? t('durSeconds', { s: parts.major })
      : parts.unit === 'minutes'
        ? t('durMinutes', { m: parts.major })
        : t('durHours', { h: parts.major, m: parts.minor ?? 0 });
  return <span className="lt-hint">{t('traderRecordRelease', { orders, rate, time })}</span>;
}

/** "Listed since", "Paused since" or "Closed since", with the time the ad came into that state. */
export function StateSince({ offer }: { offer: Offer }) {
  const { Copy } = myAdsCopy.useCopy();
  if (!offer.statusSince) return null;
  return (
    <p className="lt-hint" data-testid="state-since">
      <Copy k={offer.status === 'active' ? 'listedSince' : offer.status === 'paused' ? 'pausedSince' : 'closedSince'} />{' '}
      <Time value={offer.statusSince} />
    </p>
  );
}

export function PauseReason({ offer }: { offer: Offer }) {
  const { t } = offerCopy.useCopy();
  if (offer.pauseReason !== 'method_removed') return <p className="lt-hint">{t('pausedByYou')}</p>;
  return (
    <p className="lt-hint" data-testid="pause-reason">
      {t('pausedMethodRemoved', { fiat: offer.fiatCurrency })}{' '}
      <a className="lt-link" href="/p2p/methods">
        {t('pausedAddMethod')}
      </a>
    </p>
  );
}

/** `CounterpartyLink`: the counterparty's page, leaving a public pointer back to this offer in history. */
export function CounterpartyLink({ userId, returnTo, children }: { userId: string; returnTo: P2PReturn; children: ReactNode }) {
  const current = useCurrentNavigation();
  const href = `/checkuser?userId=${encodeURIComponent(userId)}&returnTo=${encodeURIComponent(returnTo.href)}`;
  return (
    <a
      className="lt-link"
      href={href}
      onClick={(event) => {
        if (!ordinaryClick(event)) return;
        event.preventDefault();
        if (!current()) return;
        // Add the public pointer to the departing history entry. The next
        // observed navigation retires the private view; Back mounts a fresh GET.
        history.replaceState(history.state, '', returnTo.href);
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** `BoardPages`: the first page from the read, then "Show more" continues with the cursor. */
export function BoardPages({
  pay,
  first,
  query,
  traderIds = () => [],
  children,
}: {
  pay: PersonalPayApi;
  first: OfferPage;
  query: BoardQuery & { makerId?: string };
  traderIds?: (rows: Offer[]) => string[];
  children: (rows: Offer[], traders: TraderRecords) => ReactNode;
}) {
  const { t } = offerCopy.useCopy();
  const { rows, cursor, loading, failure, more, traders } = useBoardPages(pay, first, query, traderIds);
  return (
    <>
      {children(rows, traders)}
      {failure ? <Failure result={failure} retry={more} /> : null}
      {cursor ? (
        <Button onClick={more} disabled={loading}>
          {loading ? t('loadingMore') : t('showMore')}
        </Button>
      ) : rows.length > 0 ? (
        <p className="lt-hint">{t('boardEnd')}</p>
      ) : null}
    </>
  );
}
