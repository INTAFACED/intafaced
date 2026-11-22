import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { shortReference } from '../../../shared/reference';
import { PAUSED_OFFERS_SHOWN, type PersonalPayApi } from '../pay-api';
import { id, type Offer } from '../schemas';
import { payCopy } from '../copy';
import { offerCopy } from '../p2p-offer-copy';
import { p2pDepth } from '../personal/p2p-depth-copy';
import { myAdsCopy } from '../personal/p2p-my-ads-copy';
import { isOwnOffer } from '../personal/p2p-model';
import { useTraders } from '../personal/Trader';
// The take form for a stranger's offer opened here by its reference is the board's own (`TakeOffer.tsx`, 850 lines):
// it moves to the kit with the board, not with this room.
import { TakeOfferPanel } from '../personal/P2PDepth';
import type { P2PReturn } from '../p2p-return';
import { manageOwnOffer, offerMethods, useOfferInspector } from '../p2p-offers-state';
import { Amount, Details, MutationResult, Notice, ReviewedAction, State, Status } from './parts';
import {
  CounterpartyLink,
  OfferLimits,
  OfferPrice,
  OfferSide,
  PauseReason,
  StateSince,
  TraderName,
  TraderSummary,
  settlementRow,
} from './offer-parts';
import { OfferSharing } from './sharing';

/** The kit view of the board's offer inspector (`../P2POffers.tsx`), as My offers opens it. */
export function OfferInspector({
  pay,
  userId,
  offerId,
  returnTo,
  onMarketChange,
  current,
  close,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  offerId: string;
  returnTo: P2PReturn;
  onMarketChange: () => void;
  current: () => boolean;
  close: () => void;
}) {
  const { Copy, t } = offerCopy.useCopy();
  const {
    query,
    key,
    heading,
    originalHeading,
    recordVersion,
    recordId,
    recovery,
    actionResult,
    busy,
    frameCurrent,
    refresh,
    locked,
    knownReply,
    outcome,
    checkOriginal,
  } = useOfferInspector({ pay, userId, offerId, onMarketChange, current });
  return (
    <section aria-label={t('current')}>
      <Button tone="quiet" onClick={close}>
        {t('backOwn')}
      </Button>
      <div>
        <h2 tabIndex={-1} ref={heading}>
          {t('current')}
        </h2>
        <span className="lt-mono" lang="zxx" title={offerId}>
          {shortReference(offerId)}
        </span>
      </div>
      {!locked && <MutationResult result={actionResult} title={t('current')} />}
      {locked && (
        <section aria-label={knownReply ? t('replyRetained') : payCopy.t('originalOfferActionIsUnresolved')}>
          <h3 tabIndex={-1} ref={originalHeading}>
            {knownReply ? t('replyRetained') : payCopy.t('originalOfferActionIsUnresolved')}
          </h3>
          <p>
            <Copy k={knownReply ? 'replyRetainedBody' : 'originalBody'} />
          </p>
          <p lang="zxx">
            {pay.guard
              .references(key)
              .filter((ref) => ['pause', 'resume', 'close'].includes(ref))
              .join(', ')}
          </p>
          {pay.guard.problem(key) && (
            <Notice title={payCopy.t('recoveryStorageTitle')}>{payCopy.t('deviceRecoveryStorageIsUnavailableEnableSession')}</Notice>
          )}
          <MutationResult result={actionResult} title={t('current')} />
          <Button disabled={busy} onClick={() => void checkOriginal()}>
            {pay.guard.knownCleanup(key) ? payCopy.t('retryLocalCleanup') : payCopy.t('checkOriginalOfferAction')}
          </Button>
          <MutationResult result={recovery} title={t('current')} />
        </section>
      )}
      {query.resource.status === 'failed' && (
        <p className="lt-hint">
          <Copy k="unavailableBody" />
        </p>
      )}
      <State resource={query.resource} retry={refresh}>
        {(offer) => (
          <CurrentOffer
            key={`${offer.id}:${recordId}`}
            pay={pay}
            offer={offer}
            returnTo={returnTo}
            userId={userId}
            locked={locked}
            current={() => frameCurrent() && recordVersion.current === recordId}
            recoveryCurrent={frameCurrent}
            outcome={outcome}
          />
        )}
      </State>
      <Button tone="quiet" onClick={refresh}>
        <Copy k="refresh" />
      </Button>
    </section>
  );
}

function CurrentOffer({
  pay,
  offer,
  returnTo,
  userId,
  locked,
  current,
  recoveryCurrent,
  outcome,
}: {
  pay: PersonalPayApi;
  offer: Offer;
  returnTo: P2PReturn;
  userId: string | null;
  locked: boolean;
  current: () => boolean;
  recoveryCurrent: () => boolean;
  outcome: (result: ApiResult<Offer>) => void;
}) {
  const { t } = offerCopy.useCopy();
  const myAds = myAdsCopy.useCopy();
  const own = isOwnOffer(offer, userId);
  const traders = useTraders(pay, own ? [] : [offer.makerId]);
  const record = traders[offer.makerId.toLowerCase()];
  const review = (
    <div>
      <OfferPrice offer={offer} />
      <Details
        values={[
          [payCopy.t('offer'), <span lang="zxx">{offer.id}</span>],
          [payCopy.t('makerAsset'), `${p2pDepth.t('yourOffer')} · ${offer.asset}`],
          [payCopy.t('makerSide'), <OfferSide offer={offer} own={own} />],
          [payCopy.t('currentState'), <Status value={offer.status} />],
          [payCopy.t('assetLimits'), <OfferLimits offer={offer} />],
          [
            payCopy.t('remainingQuantity'),
            <Amount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />,
          ],
          [payCopy.t('agreedPaymentMethods'), <span lang="zxx">{offerMethods(offer).join(', ')}</span>],
          ...settlementRow(offer),
          [t('terms'), offer.terms ? <span lang="und">{offer.terms}</span> : payCopy.t('noTermsSupplied')],
        ]}
      />
    </div>
  );
  const perform = (action: 'pause' | 'resume' | 'close', reviewCurrent: () => boolean) =>
    manageOwnOffer(pay, offer, action, { current, reviewCurrent, recoveryCurrent, outcome, t: myAds.t });
  return (
    <div>
      <div>
        <strong>
          <OfferSide offer={offer} own={own} />
        </strong>
        {own ? <strong>{p2pDepth.t('yourOffer')}</strong> : null}
        <Status value={offer.status} />
      </div>
      {own && offer.status === 'paused' ? <PauseReason offer={offer} /> : null}
      <OfferPrice offer={offer} />
      <Details
        values={[
          [payCopy.t('assetLimits'), <OfferLimits offer={offer} />],
          [
            payCopy.t('remainingQuantity'),
            <Amount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />,
          ],
          [
            payCopy.t('agreedPaymentMethods'),
            offerMethods(offer).length ? <span lang="zxx">{offerMethods(offer).join(', ')}</span> : payCopy.t('noUsableMethodsDeclared'),
          ],
          ...settlementRow(offer),
          [t('terms'), offer.terms ? <span lang="und">{offer.terms}</span> : payCopy.t('noTermsSupplied')],
          own
            ? [p2pDepth.t('yourOffer'), <OfferSide offer={offer} own />]
            : [
                p2pDepth.t('traderLabel'),
                <span>
                  <strong>
                    <TraderName record={record} />
                  </strong>
                  <TraderSummary record={record} />
                </span>,
              ],
        ]}
      />
      {own ? (
        offer.status !== 'closed' &&
        !locked && (
          <div className="lt-actions">
            <a className="lt-button lt-button-secondary" href={`/uc/ad/update?offerId=${encodeURIComponent(offer.id)}`}>
              {p2pDepth.t('editOffer')}
            </a>
            <ReviewedAction
              title={offer.status === 'active' ? payCopy.t('pauseOffer') : payCopy.t('resumeOffer')}
              description={payCopy.t('theServiceChecksThatYouOwnThis')}
              review={review}
              perform={(reviewCurrent) => perform(offer.status === 'active' ? 'pause' : 'resume', reviewCurrent)}
            />
            <ReviewedAction
              title={payCopy.t('closeOffer')}
              description={payCopy.t('closeThisOfferToNewOrdersExisting')}
              review={review}
              perform={(reviewCurrent) => perform('close', reviewCurrent)}
            />
            <OfferSharing pay={pay} offer={offer} onChanged={(updated) => outcome({ ok: true, data: updated })} />
          </div>
        )
      ) : (
        <>
          {id.safeParse(offer.makerId).success && (
            <CounterpartyLink userId={offer.makerId} returnTo={returnTo}>
              {payCopy.t('reviewCounterparty')}
            </CounterpartyLink>
          )}
          {offer.status === 'active' ? <TakeOfferPanel offer={offer} pay={pay} userId={userId} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * P-ads-merchant-18: the board lists active ads only, so the person's paused ads are listed here, each with why it is
 * paused and the way back (open it to resume; add a method first when the last one was removed).
 */
export function PausedOffers({
  pay,
  userId,
  revision,
  choose,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  revision: number;
  choose: (id: string, from: HTMLElement) => void;
}) {
  const { Copy, t } = offerCopy.useCopy();
  const paused = useResource((signal) => pay.pausedOffers(signal), `pay:paused-offers:${userId}:${revision}`);
  return (
    <section aria-label={t('pausedTitle')} data-testid="paused-offers">
      <h3>
        <Copy k="pausedTitle" />
      </h3>
      <State resource={paused.resource} retry={paused.reload} empty={t('pausedNone')}>
        {(offers) => (
          <>
            {offers.length >= PAUSED_OFFERS_SHOWN ? (
              <p className="lt-hint">{t('pausedMore', { count: String(PAUSED_OFFERS_SHOWN) })}</p>
            ) : null}
            <ul>
              {offers.map((offer) => (
                <li key={offer.id} data-offer-id={offer.id} data-pause-reason={offer.pauseReason ?? undefined}>
                  <div>
                    <strong>
                      <OfferSide offer={offer} own />
                    </strong>
                    <span className="lt-hint" lang="zxx">
                      {offerMethods(offer).join(', ') || payCopy.t('noUsableMethodsDeclared')}
                    </span>
                    <Status value={offer.status} />
                  </div>
                  <PauseReason offer={offer} />
                  <StateSince offer={offer} />
                  <Button onClick={(event) => choose(offer.id, event.currentTarget)}>
                    <Copy k="inspect" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </State>
    </section>
  );
}
