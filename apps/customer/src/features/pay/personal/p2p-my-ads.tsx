import { useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { CLOSED_OFFERS_SHOWN, type PersonalPayApi } from '../pay-api';
import type { Offer } from '../schemas';
import { PayFailure, PayState, PayTime, Status } from '../components';
import { myAdsCopy } from './p2p-my-ads-copy';

/**
 * P-ads-merchant-06 (J-p2p-05 #1, #2): the parts of My Ads the board does not show. The day's edit cap with when it
 * starts again, and the closed ads with why each closed and since when, each one relisted as a new ad on request.
 */
export function MyAdsLifecycle({
  pay,
  userId,
  revision,
  choose,
  side,
  onChanged,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  revision: number;
  choose: (id: string, from: HTMLElement) => void;
  /** How the board writes an ad's side, coin and price line, so a closed ad reads like the ones above it. */
  side: (offer: Offer) => React.ReactNode;
  /** A relist posted a new ad: the board and these lists read again. */
  onChanged: () => void;
}) {
  return (
    <>
      <EditQuota pay={pay} userId={userId} revision={revision} />
      <ClosedOffers pay={pay} userId={userId} revision={revision} choose={choose} side={side} onChanged={onChanged} />
    </>
  );
}

function EditQuota({ pay, userId, revision }: { pay: PersonalPayApi; userId: string | null; revision: number }) {
  const { Copy, t } = myAdsCopy.useCopy();
  const quota = useResource((signal) => pay.offerEditQuota(signal), `pay:offer-edit-quota:${userId}:${revision}`);
  const resource = quota.resource;
  return (
    <section className="stack" aria-label={t('editsTitle')} data-testid="edit-quota">
      <h3>
        <Copy k="editsTitle" />
      </h3>
      {resource.status === 'ready' ? (
        <p className="muted" data-remaining={resource.data.remaining}>
          <EditsLine quota={resource.data} />
        </p>
      ) : resource.status === 'failed' && resource.failure.code === 'p2p.config_unset' ? (
        <p className="muted">
          <Copy k="editsUnset" />
        </p>
      ) : (
        <PayState resource={resource} retry={quota.reload}>
          {() => null}
        </PayState>
      )}
    </section>
  );
}

function EditsLine({ quota }: { quota: { limit: number; used: number; remaining: number; resetsAt: string } }) {
  const { t } = myAdsCopy.useCopy();
  const key = quota.remaining > 0 ? 'editsUsed' : 'editsSpent';
  const [before, after] = t(key, { used: String(quota.used), limit: String(quota.limit), time: '\u0000' }).split('\u0000');
  return (
    <>
      {before}
      <PayTime value={quota.resetsAt} />
      {after}
    </>
  );
}

function ClosedOffers({
  pay,
  userId,
  revision,
  choose,
  side,
  onChanged,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  revision: number;
  choose: (id: string, from: HTMLElement) => void;
  side: (offer: Offer) => React.ReactNode;
  onChanged: () => void;
}) {
  const { Copy, t } = myAdsCopy.useCopy();
  const closed = useResource((signal) => pay.closedOffers(signal), `pay:closed-offers:${userId}:${revision}`);
  return (
    <section className="stack" aria-label={t('closedTitle')} data-testid="closed-offers">
      <h3>
        <Copy k="closedTitle" />
      </h3>
      <PayState resource={closed.resource} retry={closed.reload} empty={t('closedNone')}>
        {(offers) => (
          <>
            {offers.length >= CLOSED_OFFERS_SHOWN ? (
              <p className="muted">{t('closedMore', { count: String(CLOSED_OFFERS_SHOWN) })}</p>
            ) : null}
            <ul className="p2p-offer-list">
              {offers.map((offer) => (
                <ClosedOffer key={offer.id} offer={offer} pay={pay} choose={choose} side={side} onChanged={onChanged} />
              ))}
            </ul>
          </>
        )}
      </PayState>
    </section>
  );
}

function ClosedOffer({
  offer,
  pay,
  choose,
  side,
  onChanged,
}: {
  offer: Offer;
  pay: PersonalPayApi;
  choose: (id: string, from: HTMLElement) => void;
  side: (offer: Offer) => React.ReactNode;
  onChanged: () => void;
}) {
  const { Copy } = myAdsCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<Offer> | null>(null);
  // Relisted already (here or earlier): the ad it became, and no second Relist.
  const relistedAs = result?.ok ? result.data.id : (offer.relistedAs ?? null);
  async function relist() {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await pay.relistOffer(offer.id);
      setResult(outcome);
      if (outcome.ok) onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="p2p-offer-row" data-offer-id={offer.id} data-close-reason={offer.closeReason ?? undefined}>
      <div className="p2p-offer-maker">
        <strong>{side(offer)}</strong>
        <Status value={offer.status} />
      </div>
      <p className="muted" data-testid="close-reason">
        <Copy k={offer.closeReason === 'by_you' ? 'closedByYou' : offer.closeReason === 'sold_out' ? 'closedSoldOut' : 'closedPlain'} />
      </p>
      <StateSince offer={offer} />
      {relistedAs ? (
        <p role="status" data-testid="relisted" data-new-offer-id={relistedAs}>
          <Copy k="relisted" />{' '}
          <Button variant="secondary" onClick={(event) => choose(relistedAs, event.currentTarget)}>
            <Copy k="openRelisted" />
          </Button>
        </p>
      ) : (
        <div className="actions">
          <p className="muted">
            <Copy k="relistBody" />
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => void relist()}>
            <Copy k={busy ? 'relisting' : 'relist'} />
          </Button>
        </div>
      )}
      {result && !result.ok ? <PayFailure result={result} /> : null}
    </li>
  );
}

/** "Listed since", "Paused since" or "Closed since", with the time the ad came into that state. */
export function StateSince({ offer }: { offer: Offer }) {
  const { Copy } = myAdsCopy.useCopy();
  if (!offer.statusSince) return null;
  return (
    <p className="muted" data-testid="state-since">
      <Copy k={offer.status === 'active' ? 'listedSince' : offer.status === 'paused' ? 'pausedSince' : 'closedSince'} />{' '}
      <PayTime value={offer.statusSince} />
    </p>
  );
}

/**
 * Closing an ad with open orders is refused with how many (P-ads-merchant-06): say so in plain words, with the count the
 * service gave, and point at the orders. Any other answer is shown as it came.
 */
export function closeRefusal<T>(result: ApiResult<T>, t: ReturnType<typeof myAdsCopy.useCopy>['t']): ApiResult<T> {
  if (result.ok || result.code !== 'p2p.offer_has_open_trades') return result;
  const count = result.p2pLimit?.openTrades ?? String(result.p2pLimit?.openTradeIds?.length ?? '');
  if (!count) return result;
  return { ...result, message: count === '1' ? t('closeHasOneOpenTrade') : t('closeHasOpenTrades', { count }) };
}
