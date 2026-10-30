import { useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { decimalSchema, displayAmount } from '../../shared/money';
import { Button, EmptyState, Failure, Panel } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { Details, Read } from './common';
import { listingSchema } from './Market';
import { marketListingCopy } from './market-listing-copy';
import { reviewablePurchase, reviewKey } from './market-listing';

const uuid = z.string().guid();
const time = z.string().datetime({ offset: true });

/** svc-market `market.listing` (MC-market-01): public, with no seller user id; performance is unreported. */
const listingDetailSchema = z.object({
  listing: listingSchema,
  vendor: z.object({ id: uuid, displayName: z.string(), description: z.string(), createdAt: time }),
  activeListingCount: z.number().int().positive(),
  reviews: z.object({ count: z.string().regex(/^(0|[1-9][0-9]*)$/), mean: decimalSchema.nullable(), meanRounding: z.string() }),
  terms: z.object({
    offerType: z.enum(['one_time', 'subscription']),
    assetId: z.string().min(1),
    price: decimalSchema,
    periodSeconds: z.number().int().positive().nullable(),
  }),
  performance: z.object({ reported: z.literal(false) }),
});
const reviewRowSchema = z.object({
  id: uuid,
  listingId: uuid,
  vendorId: uuid,
  score: z.number().int(),
  text: z.string().nullable(),
  createdAt: time,
});
const reviewListSchema = z.object({ reviews: z.array(reviewRowSchema), nextCursor: z.string().nullable() });
const myPurchaseSchema = z.object({ id: uuid, listingId: uuid, buyerId: uuid, status: z.string(), createdAt: time });
const reviewOutSchema = z.object({ id: uuid, purchaseId: uuid, listingId: uuid, score: z.number().int(), text: z.string().nullable() });

const SCORES = [5, 4, 3, 2, 1] as const;

/** `/market/<listingId>`: one listing's own page, with its terms, seller, reviews and performance basis. */
export function MarketListingPage({ listingId }: { listingId: string }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  const detail = useResource(
    (signal) => api.query('market', 'listing', { listingId }, listingDetailSchema, { signal }),
    `market-listing:${listingId}`,
  );
  const back = (
    <a className="text-link" href="/market">
      {t('backToMarket')}
    </a>
  );
  if (
    detail.resource.status === 'failed' &&
    (detail.resource.failure.code === 'market.listing_not_found' || !uuid.safeParse(listingId).success)
  )
    return (
      <Panel title={t('notFound')}>
        <EmptyState title={t('notFound')} action={back}>
          {t('notFoundBody')} <code lang="zxx">market.listing_not_found</code>
        </EmptyState>
      </Panel>
    );
  return (
    <div className="more-grid">
      {back}
      <Read resource={detail.resource} retry={detail.reload}>
        {(d) => <ListingBody detail={d} onReviewed={detail.reload} />}
      </Read>
    </div>
  );
}

function ListingBody({ detail, onReviewed }: { detail: z.infer<typeof listingDetailSchema>; onReviewed: () => void }) {
  const { t } = marketListingCopy.useCopy();
  const preferences = usePreferences();
  const { userId } = useSession();
  const date = (at: string) => new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium' }).format(new Date(at));
  const { listing, vendor, terms, reviews } = detail;
  const [revision, setRevision] = useState(0);
  return (
    <Panel title={<span lang="und">{listing.title}</span>}>
      <p data-testid="more-body" className="more-body" lang="und">
        {listing.description}
      </p>
      <div className="market-listing-regions">
        <section aria-labelledby="market-listing-terms">
          <h3 id="market-listing-terms">{t('terms')}</h3>
          <Details
            items={[
              [t('listingType'), terms.offerType === 'subscription' ? t('strategySubscription') : t('accessListing')],
              [
                t('price'),
                <span key="price" lang="zxx">
                  {displayAmount(terms.price)} {terms.assetId}
                </span>,
              ],
              [t('period'), terms.periodSeconds ? t('periodSeconds', { seconds: terms.periodSeconds }) : t('periodNone')],
            ]}
          />
        </section>
        <section aria-labelledby="market-listing-seller">
          <h3 id="market-listing-seller">{t('seller')}</h3>
          <strong lang="und">{vendor.displayName}</strong>
          <p lang="und">{vendor.description}</p>
          <p className="muted">
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
                {t('reviewsSummary', { count: reviews.count, mean: displayAmount(reviews.mean) })}
              </p>
              <p className="muted">{t('reviewsRounding')}</p>
            </>
          )}
          {userId ? <ReviewList key={revision} listingId={listing.id} /> : <p className="muted">{t('reviewsSignIn')}</p>}
          <WriteReview
            listingId={listing.id}
            onPosted={() => {
              setRevision((n) => n + 1);
              onReviewed();
            }}
          />
        </section>
        <section aria-labelledby="market-listing-performance">
          <h3 id="market-listing-performance">{t('performance')}</h3>
          <p>{t('performanceNone')}</p>
          <p className="muted">{t('performanceBasis')}</p>
        </section>
      </div>
    </Panel>
  );
}

function ReviewList({ listingId }: { listingId: string }) {
  const api = useApi();
  const { t } = marketListingCopy.useCopy();
  const preferences = usePreferences();
  const list = useResource(
    (signal) => api.query('market', 'reviews.list', { listingId, limit: 20 }, reviewListSchema, { signal }),
    `market-reviews:${listingId}`,
  );
  return (
    <Read resource={list.resource} retry={list.reload}>
      {({ reviews }) =>
        reviews.length === 0 ? null : (
          <ul className="more-list" aria-label={t('reviews')}>
            {reviews.map((review) => (
              <li key={review.id} data-review={review.id}>
                <strong>{t('scoreOf', { score: review.score })}</strong>
                {review.text ? <p lang="und">{review.text}</p> : null}
                <small className="muted">
                  {new Intl.DateTimeFormat(preferences.language, { dateStyle: 'medium' }).format(new Date(review.createdAt))}
                </small>
              </li>
            ))}
          </ul>
        )
      }
    </Read>
  );
}

type Outcome =
  | { kind: 'posted' }
  | { kind: 'refused'; text: string; code: string }
  | { kind: 'failed'; result: Extract<ApiResult<unknown>, { ok: false }> };

function WriteReview({ listingId, onPosted }: { listingId: string; onPosted: () => void }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = marketListingCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState<number>(5);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  if (!userId) return <p className="muted">{t('reviewSignIn')}</p>;

  const refusalOf = (code: string | undefined): Outcome | null =>
    code === 'market.review_exists'
      ? { kind: 'refused', text: t('reviewExists'), code }
      : code === 'market.review_not_settled' || code === 'market.review_not_buyer'
        ? { kind: 'refused', text: t('reviewNotSettled'), code }
        : null;

  /** The purchase that may review, read fresh from svc-market, or the refusal the service would give without one. */
  async function purchase(): Promise<{ id: string } | Outcome> {
    const mine = await api.query(
      'market',
      'myPurchases',
      { limit: 50 },
      z.array(myPurchaseSchema).refine((rows) => rows.every((row) => row.buyerId === userId)),
    );
    if (!mine.ok) return { kind: 'failed', result: mine };
    return reviewablePurchase(mine.data, listingId) ?? { kind: 'refused', text: t('reviewNotSettled'), code: 'market.review_not_settled' };
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
    const found = await purchase();
    if ('kind' in found) {
      setBusy(false);
      setOutcome(found);
      return;
    }
    const body = text.trim();
    const result = await api.mutate(
      'market',
      'reviews.submit',
      { purchaseId: found.id, score, text: body || undefined, clientRequestId: reviewKey(found.id, score, body) },
      reviewOutSchema.refine((row) => row.purchaseId === found.id && row.listingId === listingId && row.score === score),
    );
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setText('');
      setOutcome({ kind: 'posted' });
      onPosted();
      return;
    }
    setOutcome(refusalOf(result.code) ?? { kind: 'failed', result });
  }

  return (
    <div className="market-review-form">
      {!open ? (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void begin()}>
            {t('writeReview')}
          </Button>
        </div>
      ) : (
        <form
          aria-label={t('yourReview')}
          className="market-review-form"
          onSubmit={(event) => {
            event.preventDefault();
            void post();
          }}
        >
          <label className="field">
            <span>{t('score')}</span>
            <select value={score} onChange={(event) => setScore(Number(event.target.value))}>
              {SCORES.map((value) => (
                <option key={value} value={value}>
                  {t('scoreOf', { score: value })}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('reviewText')}</span>
            <textarea value={text} maxLength={1_000} rows={4} onChange={(event) => setText(event.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={busy}>
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
      {outcome?.kind === 'failed' ? <Failure result={outcome.result} /> : null}
    </div>
  );
}
