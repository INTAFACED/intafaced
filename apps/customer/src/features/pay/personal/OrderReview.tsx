import { useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { PayFailure, PaySection, PayState, PayTime } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { OrderReview as Review, Trade } from '../schemas';
import { orderReviewCopy } from './order-review-copy';

/**
 * One good or bad review per party of a completed order (svc-p2p `reviews.*`). The page shows the viewer's own review
 * once it exists, never a second form; the other party's review of them shows while it is visible.
 */
export function OrderReview({ pay, trade }: { pay: PersonalPayApi; trade: Trade }) {
  const { t } = orderReviewCopy.useCopy();
  const completed = trade.status === 'released';
  return (
    <PaySection title={t('title')} description={completed ? t('body') : undefined}>
      {completed ? <ReviewPanel pay={pay} trade={trade} /> : <p className="muted">{t('onlyCompleted')}</p>}
    </PaySection>
  );
}

function ReviewPanel({ pay, trade }: { pay: PersonalPayApi; trade: Trade }) {
  const { t } = orderReviewCopy.useCopy();
  const query = useResource((signal) => pay.orderReviews(trade.id, signal), `pay:order-reviews:${pay.viewer}:${trade.id}`);
  return (
    <PayState resource={query.resource} retry={query.reload}>
      {(reviews) => (
        <div className="stack" data-testid="order-review">
          {reviews.mine ? (
            <MyReview pay={pay} trade={trade} review={reviews.mine} onChanged={query.reload} />
          ) : (
            <ReviewForm pay={pay} trade={trade} onDone={query.reload} />
          )}
          {reviews.theirs ? (
            <>
              <ReviewView review={reviews.theirs} heading={t('theirs')} />
              {reviews.theirs.reply === null ? <ReplyForm pay={pay} trade={trade} onDone={query.reload} /> : null}
            </>
          ) : (
            <p className="muted">{t('theirsNone')}</p>
          )}
        </div>
      )}
    </PayState>
  );
}

function ReviewView({ review, heading }: { review: Review; heading: string }) {
  const { t } = orderReviewCopy.useCopy();
  return (
    <section aria-label={heading} data-review={review.id}>
      <h4>{heading}</h4>
      <p>
        <strong>{t(review.rating)}</strong> · <PayTime value={review.createdAt} />
      </p>
      {review.comment ? (
        <p lang="und" dir="auto">
          {review.comment}
        </p>
      ) : null}
      {review.explanation ? (
        <p lang="und" dir="auto">
          {review.explanation}
        </p>
      ) : null}
      {review.reply !== null ? (
        <p>
          {t('replyHeading')}{' '}
          <span lang="und" dir="auto">
            {review.reply}
          </span>
        </p>
      ) : null}
      {review.hidden ? <p className="muted">{t('hidden', { reason: review.hiddenReason ?? '' })}</p> : null}
    </section>
  );
}

/** The viewer's own review, and its edit while the owner's window lasts; one with a reply or a hide stays as it is. */
function MyReview({ pay, trade, review, onChanged }: { pay: PersonalPayApi; trade: Trade; review: Review; onChanged: () => void }) {
  const { t } = orderReviewCopy.useCopy();
  const [editing, setEditing] = useState(false);
  const fixed = review.reply !== null || review.hidden;
  return (
    <>
      <ReviewView review={review} heading={t('yours')} />
      {editing ? (
        <ReviewForm pay={pay} trade={trade} existing={review} onDone={onChanged} />
      ) : fixed ? (
        <p className="muted">{t(review.hidden ? 'editHidden' : 'editReplied')}</p>
      ) : (
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {t('edit')}
        </Button>
      )}
    </>
  );
}

/** One reply from the person a review is about. */
function ReplyForm({ pay, trade, onDone }: { pay: PersonalPayApi; trade: Trade; onDone: () => void }) {
  const { t } = orderReviewCopy.useCopy();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<Review>, { ok: false }> | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.replyReview({ tradeId: trade.id, text: text.trim() });
    setBusy(false);
    if (result.ok) onDone();
    else setFailure(result);
  };
  return (
    <form
      className="stack"
      aria-label={t('replyLabel')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="field">
        <span>{t('replyLabel')}</span>
        <textarea value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} />
      </label>
      <p className="muted">{t('replyOnce')}</p>
      <Button type="submit" variant="secondary" disabled={!text.trim() || busy}>
        {t('reply')}
      </Button>
      {failure ? <PayFailure result={failure} retry={send} /> : null}
    </form>
  );
}

function ReviewForm({ pay, trade, existing, onDone }: { pay: PersonalPayApi; trade: Trade; existing?: Review; onDone: () => void }) {
  const { t } = orderReviewCopy.useCopy();
  const [rating, setRating] = useState<'good' | 'bad' | null>(existing?.rating ?? null);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [explanation, setExplanation] = useState(existing?.explanation ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<Review>, { ok: false }> | null>(null);
  const ready = rating === 'good' || (rating === 'bad' && explanation.trim() !== '');
  const leave = async () => {
    if (!ready || rating === null) return;
    setBusy(true);
    setFailure(null);
    const result = await (existing ? pay.editReview : pay.leaveReview)({
      tradeId: trade.id,
      rating,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(rating === 'bad' ? { explanation: explanation.trim() } : {}),
    });
    setBusy(false);
    if (result.ok) onDone();
    else setFailure(result);
  };
  return (
    <form
      className="stack"
      aria-label={t(existing ? 'editLabel' : 'formLabel')}
      onSubmit={(event) => {
        event.preventDefault();
        void leave();
      }}
    >
      <div role="group" aria-label={t('ratingLabel')} className="row">
        <Button
          type="button"
          variant={rating === 'good' ? 'primary' : 'secondary'}
          aria-pressed={rating === 'good'}
          onClick={() => setRating('good')}
        >
          {t('good')}
        </Button>
        <Button
          type="button"
          variant={rating === 'bad' ? 'primary' : 'secondary'}
          aria-pressed={rating === 'bad'}
          onClick={() => setRating('bad')}
        >
          {t('bad')}
        </Button>
      </div>
      <label className="field">
        <span>{t('commentLabel')}</span>
        <textarea value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} />
      </label>
      {rating === 'bad' ? (
        <label className="field">
          <span>{t('explanationLabel')}</span>
          <textarea value={explanation} maxLength={2000} required onChange={(event) => setExplanation(event.target.value)} />
        </label>
      ) : null}
      {existing ? null : <p className="muted">{t('onePerParty')}</p>}
      <Button type="submit" disabled={!ready || busy}>
        {busy ? t('leaving') : t(existing ? 'save' : 'leave')}
      </Button>
      {failure ? <PayFailure result={failure} retry={leave} /> : null}
    </form>
  );
}
