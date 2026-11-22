import { useState } from 'react';
import {
  MARKET_LISTING,
  MARKET_MY_PURCHASES,
  MARKET_REVIEWS_LIST,
  MARKET_REVIEWS_SUBMIT,
  type MarketListingDetail,
} from '@intafaced/contracts/market-procedures';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate, KeyValue } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { t as copyText } from './copy';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { EmptyNote, FailureNote, KitRead, Section } from './volt-parts';
import { periodUnit } from './market-explorer';
import { marketExplorerCopy } from './market-explorer-copy';
import { marketListingCopy } from './market-listing-copy';
import { reviewablePurchase, reviewKey } from './market-listing';

const SCORES = [5, 4, 3, 2, 1] as const;
/** The most purchases one read returns (svc-market `myPurchases`, which has no cursor). */
const PURCHASES_READ = 50;

/** `/market/<listingId>`: one listing's own page, with its terms, seller, reviews and performance basis. */
export function MarketListingPage({ listingId }: { listingId: string }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  // An id that cannot be a listing is answered here, without asking the service. The service answers an unknown or
  // withdrawn listing 404 (`market.listing_not_found`, the only NOT_FOUND of its `listing` read).
  const wellFormed = MARKET_LISTING.input.safeParse({ listingId }).success;
  const detail = useResource(
    (signal) =>
      wellFormed
        ? api.call(MARKET_LISTING, { listingId }, { signal })
        : Promise.resolve<ApiResult<MarketListingDetail>>({
            ok: false,
            reason: 'not_mounted',
            message: 'market.listing_not_found',
            code: 'market.listing_not_found',
          }),
    `market-listing:${listingId}`,
  );
  const back = (
    <a className="lt-link" href="/market">
      {t('backToMarket')}
    </a>
  );
  const missing = !wellFormed || (detail.resource.status === 'failed' && detail.resource.failure.status === 404);
  return (
    <CatalogueTemplate
      title={moreRoomRoutesCopy.t('market')}
      description={copyText('moreroutes.published.catalogue.terms.and.your.seller.workspace')}
      state={{ kind: 'ready' }}
      items={null}
      item={
        missing ? (
          <Section title={t('notFound')}>
            <EmptyNote title={t('notFound')} action={back}>
              {t('notFoundBody')} <code lang="zxx">market.listing_not_found</code>
            </EmptyNote>
          </Section>
        ) : (
          <div>
            {back}
            <KitRead resource={detail.resource} retry={detail.reload}>
              {(d) => <ListingBody detail={d} />}
            </KitRead>
          </div>
        )
      }
    />
  );
}

function ListingBody({ detail }: { detail: MarketListingDetail }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  const explorer = marketExplorerCopy.useCopy();
  const preferences = usePreferences();
  const { userId } = useSession();
  const date = (at: string) => new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium' }).format(new Date(at));
  const { listing, vendor, terms } = detail;
  // After a review posts, only the summary and the list are read again, so the page and its message stay on screen.
  const [reviews, setReviews] = useState(detail.reviews);
  const [revision, setRevision] = useState(0);
  const period = terms.periodSeconds ? periodUnit(terms.periodSeconds) : null;
  return (
    <Section title={<span lang="und">{listing.title}</span>}>
      <p data-testid="more-body" lang="und">
        {listing.description}
      </p>
      <div className="lt-grid">
        <section aria-labelledby="market-listing-terms">
          <h3 id="market-listing-terms">{t('terms')}</h3>
          <KeyValue
            rows={[
              { label: t('listingType'), value: terms.offerType === 'subscription' ? t('strategySubscription') : t('accessListing') },
              {
                label: t('price'),
                value: (
                  <span lang="zxx">
                    {displayAmount(terms.price)} {terms.assetId}
                  </span>
                ),
              },
              { label: t('period'), value: period ? explorer.t(`every_${period.unit}`, { value: period.value }) : t('periodNone') },
            ]}
          />
        </section>
        <section aria-labelledby="market-listing-seller">
          <h3 id="market-listing-seller">{t('seller')}</h3>
          <strong lang="und">{vendor.displayName}</strong>
          <p lang="und">{vendor.description}</p>
          <p className="lt-hint">
            {t('sellerSince', { date: date(vendor.createdAt) })} · {t('activeListings', { count: detail.activeListingCount })}
          </p>
        </section>
        <section aria-labelledby="market-listing-reviews">
          <h3 id="market-listing-reviews">{t('reviews')}</h3>
          {reviews.count === '0' || reviews.mean === null ? (
            <p role="status">{t('reviewsNone')}</p>
          ) : (
            <>
              <p role="status" data-testid="market-review-summary">
                {t('reviewsSummary', { count: displayAmount(reviews.count), mean: displayAmount(reviews.mean) })}
              </p>
              <p className="lt-hint">{t('reviewsRounding')}</p>
            </>
          )}
          {userId ? (
            <>
              <ReviewList key={revision} listingId={listing.id} />
              <WriteReview
                listingId={listing.id}
                onPosted={async () => {
                  setRevision((n) => n + 1);
                  const again = await api.call(MARKET_LISTING, { listingId: listing.id });
                  if (again.ok) setReviews(again.data.reviews);
                }}
              />
            </>
          ) : (
            <p className="lt-hint">{t('reviewsSignIn')}</p>
          )}
        </section>
        <section aria-labelledby="market-listing-performance">
          <h3 id="market-listing-performance">{t('performance')}</h3>
          <p>{t('performanceNone')}</p>
          <p className="lt-hint">{t('performanceBasis')}</p>
        </section>
      </div>
    </Section>
  );
}

function ReviewList({ listingId }: { listingId: string }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  const preferences = usePreferences();
  const list = useResource((signal) => api.call(MARKET_REVIEWS_LIST, { listingId, limit: 20 }, { signal }), `market-reviews:${listingId}`);
  return (
    <KitRead resource={list.resource} retry={list.reload}>
      {({ reviews }) =>
        reviews.length === 0 ? null : (
          <ul aria-label={t('reviews')}>
            {reviews.map((review) => (
              <li key={review.id} data-review={review.id}>
                <strong>{t('scoreOf', { score: review.score })}</strong>
                {review.text ? <p lang="und">{review.text}</p> : null}
                <small className="lt-hint">
                  {new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium' }).format(new Date(review.createdAt))}
                </small>
              </li>
            ))}
          </ul>
        )
      }
    </KitRead>
  );
}

type Outcome =
  | { kind: 'posted' }
  | { kind: 'refused'; text: string; code: string }
  | { kind: 'unseen' }
  | { kind: 'failed'; result: Extract<ApiResult<unknown>, { ok: false }> };

function WriteReview({ listingId, onPosted }: { listingId: string; onPosted: () => Promise<void> }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = marketListingCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState<number>(5);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const refusalOf = (code: string | undefined): Outcome | null =>
    code === 'market.review_exists'
      ? { kind: 'refused', text: t('reviewExists'), code }
      : code === 'market.review_not_settled' || code === 'market.review_not_buyer'
        ? { kind: 'refused', text: t('reviewNotSettled'), code }
        : null;

  /**
   * The purchase that may review, read fresh from svc-market before each step (it can change between opening the form
   * and posting it), or what stops the review.
   */
  async function purchase(): Promise<{ id: string } | Outcome> {
    const mine = await api.call(
      MARKET_MY_PURCHASES,
      { limit: PURCHASES_READ },
      { accept: (rows) => rows.every((row) => row.buyerId === userId) },
    );
    if (!mine.ok) return { kind: 'failed', result: mine };
    const found = reviewablePurchase(mine.data, listingId);
    if (found) return found;
    // A full page may hide an older purchase that could review: say so, never a refusal the service did not give.
    if (mine.data.length >= PURCHASES_READ) return { kind: 'unseen' };
    return { kind: 'refused', text: t('reviewNotSettled'), code: 'market.review_not_settled' };
  }

  async function begin() {
    setBusy(true);
    setOutcome(null);
    const found = await purchase();
    setBusy(false);
    if ('kind' in found) setOutcome(found);
    else setOpen(true);
  }

  async function post() {
    setBusy(true);
    setOutcome(null);
    const found = await purchase();
    if ('kind' in found) {
      setBusy(false);
      setOutcome(found);
      return;
    }
    const body = text.trim();
    const result = await api.call(
      MARKET_REVIEWS_SUBMIT,
      { purchaseId: found.id, score, text: body || undefined, clientRequestId: reviewKey(found.id, score, body) },
      { accept: (row) => row.purchaseId === found.id && row.listingId === listingId && row.score === score },
    );
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setText('');
      setOutcome({ kind: 'posted' });
      await onPosted();
      return;
    }
    setOutcome(refusalOf(result.code) ?? { kind: 'failed', result });
  }

  return (
    <div>
      {!open ? (
        <div>
          <Button tone="secondary" disabled={busy} onClick={() => void begin()}>
            {t('writeReview')}
          </Button>
        </div>
      ) : (
        <form
          aria-label={t('yourReview')}
          onSubmit={(event) => {
            event.preventDefault();
            void post();
          }}
        >
          <label className="lt-field">
            <span>{t('score')}</span>
            <select value={score} onChange={(event) => setScore(Number(event.target.value))}>
              {SCORES.map((value) => (
                <option key={value} value={value}>
                  {t('scoreOf', { score: value })}
                </option>
              ))}
            </select>
          </label>
          <label className="lt-field">
            <span>{t('reviewText')}</span>
            <textarea value={text} maxLength={1_000} rows={4} onChange={(event) => setText(event.target.value)} />
          </label>
          <div>
            <Button tone="primary" type="submit" disabled={busy}>
              {t('postReview')}
            </Button>
          </div>
        </form>
      )}
      {outcome?.kind === 'posted' ? <p role="status">{t('reviewPosted')}</p> : null}
      {outcome?.kind === 'refused' ? (
        <p role="alert" data-code={outcome.code}>
          {outcome.text} <code lang="zxx">{outcome.code}</code>
        </p>
      ) : null}
      {outcome?.kind === 'unseen' ? <p role="status">{t('reviewUnseen', { count: PURCHASES_READ })}</p> : null}
      {outcome?.kind === 'failed' ? <FailureNote result={outcome.result} /> : null}
    </div>
  );
}
