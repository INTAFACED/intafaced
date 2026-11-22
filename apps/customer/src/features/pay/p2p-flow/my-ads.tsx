import { useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { CLOSED_OFFERS_SHOWN, type PersonalPayApi } from '../pay-api';
import type { Offer } from '../schemas';
import { myAdsCopy } from '../personal/p2p-my-ads-copy';
import { Failure, State, Status, Time } from './parts';
import { StateSince } from './offer-parts';

/**
 * The kit view of `../personal/p2p-my-ads.tsx` (P-ads-merchant-06, J-p2p-05 #1, #2): the day's edit cap with when it
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
  side: (offer: Offer) => ReactNode;
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
    <section aria-label={t('editsTitle')} data-testid="edit-quota">
      <h3>
        <Copy k="editsTitle" />
      </h3>
      {resource.status === 'ready' ? (
        <p className="lt-hint" data-remaining={resource.data.remaining}>
          <EditsLine quota={resource.data} />
        </p>
      ) : resource.status === 'failed' && resource.failure.code === 'p2p.config_unset' ? (
        <p className="lt-hint">
          <Copy k="editsUnset" />
        </p>
      ) : (
        <State resource={resource} retry={quota.reload}>
          {() => null}
        </State>
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
      <Time value={quota.resetsAt} />
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
  side: (offer: Offer) => ReactNode;
  onChanged: () => void;
}) {
  const { Copy, t } = myAdsCopy.useCopy();
  const closed = useResource((signal) => pay.closedOffers(signal), `pay:closed-offers:${userId}:${revision}`);
  return (
    <section aria-label={t('closedTitle')} data-testid="closed-offers">
      <h3>
        <Copy k="closedTitle" />
      </h3>
      <State resource={closed.resource} retry={closed.reload} empty={t('closedNone')}>
        {(offers) => (
          <>
            {offers.length >= CLOSED_OFFERS_SHOWN ? (
              <p className="lt-hint">{t('closedMore', { count: String(CLOSED_OFFERS_SHOWN) })}</p>
            ) : null}
            <ul>
              {offers.map((offer) => (
                <ClosedOffer key={offer.id} offer={offer} pay={pay} choose={choose} side={side} onChanged={onChanged} />
              ))}
            </ul>
          </>
        )}
      </State>
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
  side: (offer: Offer) => ReactNode;
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
    <li data-offer-id={offer.id} data-close-reason={offer.closeReason ?? undefined}>
      <div>
        <strong>{side(offer)}</strong>
        <Status value={offer.status} />
      </div>
      <p className="lt-hint" data-testid="close-reason">
        <Copy k={offer.closeReason === 'by_you' ? 'closedByYou' : offer.closeReason === 'sold_out' ? 'closedSoldOut' : 'closedPlain'} />
      </p>
      <StateSince offer={offer} />
      {relistedAs ? (
        <p role="status" data-testid="relisted" data-new-offer-id={relistedAs}>
          <Copy k="relisted" />{' '}
          <Button onClick={(event) => choose(relistedAs, event.currentTarget)}>
            <Copy k="openRelisted" />
          </Button>
        </p>
      ) : (
        <div className="lt-actions">
          <p className="lt-hint">
            <Copy k="relistBody" />
          </p>
          <Button disabled={busy} onClick={() => void relist()}>
            <Copy k={busy ? 'relisting' : 'relist'} />
          </Button>
        </div>
      )}
      {result && !result.ok ? <Failure result={result} /> : null}
    </li>
  );
}
