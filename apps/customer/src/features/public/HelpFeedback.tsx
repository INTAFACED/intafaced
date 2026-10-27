import { useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Loading } from '../../shared/ui';
import { safeReturnTo } from '../../app/navigation';
import { useSession } from '../session/session';
import { sendArticleFeedback } from '../more/support-calls';
import { supportRequestHref } from '../more/support-desk';
import { helpFeedbackCopy as copy } from './help-feedback-copy';

type Vote = { helpful: boolean; ticketId?: string; earlier?: true };
type State =
  | { step: 'ask' }
  | { step: 'comment'; comment: string; asRequest: boolean; missing: boolean }
  | { step: 'sending' }
  | { step: 'done'; vote: Vote; askedRequest: boolean }
  | { step: 'failed'; failure: Extract<ApiResult<unknown>, { ok: false }>; back: State };

/**
 * "Did this answer help?" under a published answer (SP-kb-03, J-support-public-01 #8). Signed out it offers sign-in back
 * to this answer. Signed in, "Yes" is one vote; "No" takes an optional comment and can send it as a support request whose
 * first message names the answer. One vote per account per version: a second vote is answered with the first, and said so.
 * The owner's vote rate binds every vote; over it, or with it blank, the service refuses and nothing is kept.
 */
export function HelpFeedback({ articleId, version }: { articleId: string; version: number }) {
  const { t } = copy.useCopy();
  const { api, userId, session } = useSession();
  const [state, setState] = useState<State>({ step: 'ask' });
  const sending = useRef(false);
  if (!session) {
    return (
      <section className="help__card help__measure" aria-label={t('question')} data-testid="help-feedback">
        <h2>{t('question')}</h2>
        <p className="muted">{t('signedOut')}</p>
        <a
          className="button button--secondary"
          href={`/login?redirect=${encodeURIComponent(safeReturnTo(location.pathname + location.search))}`}
        >
          {t('signIn')}
        </a>
      </section>
    );
  }
  async function send(helpful: boolean, comment = '', asRequest = false, back: State = { step: 'ask' }) {
    if (sending.current) return;
    sending.current = true;
    setState({ step: 'sending' });
    // One business key per account and version: a retry or a second tap replays the first answer instead of counting again.
    const clientRequestId = `kb-vote:${articleId}:${version}`;
    try {
      const result = await sendArticleFeedback(api, {
        articleId,
        userId,
        helpful,
        clientRequestId,
        ...(comment ? { comment } : {}),
        ...(asRequest ? { openRequest: true } : {}),
      });
      if (!result.ok) return setState({ step: 'failed', failure: result, back });
      // The service answers a vote that meets an earlier one with that first vote. A replayed key carries no flag, so a
      // different answer, or a request that did not open, is read as the first vote standing too.
      const earlier = Boolean(result.data.earlier) || result.data.helpful !== helpful || (asRequest && !result.data.ticketId);
      setState({ step: 'done', vote: { ...result.data, ...(earlier ? { earlier: true } : {}) }, askedRequest: asRequest });
    } finally {
      sending.current = false;
    }
  }
  return (
    <section className="help__card help__measure" aria-label={t('question')} data-testid="help-feedback">
      <h2>{t('question')}</h2>
      {state.step === 'ask' && (
        <div className="help__actions">
          <Button variant="secondary" onClick={() => void send(true)}>
            {t('yes')}
          </Button>
          <Button variant="secondary" onClick={() => setState({ step: 'comment', comment: '', asRequest: false, missing: false })}>
            {t('no')}
          </Button>
        </div>
      )}
      {state.step === 'comment' && (
        <form
          className="help__feedback"
          onSubmit={(event) => {
            event.preventDefault();
            const comment = state.comment.trim();
            if (state.asRequest && !comment) return setState({ ...state, missing: true });
            void send(false, comment, state.asRequest, state);
          }}
        >
          <label className="field">
            <span>{t('commentLabel')}</span>
            <textarea
              name="help-feedback-comment"
              value={state.comment}
              maxLength={2000}
              rows={3}
              aria-invalid={state.missing}
              onChange={(event) => setState({ ...state, comment: event.target.value, missing: false })}
            />
            {state.missing && <small className="error-text">{t('requestNeedsComment')}</small>}
          </label>
          <label className="help__check">
            <input
              type="checkbox"
              checked={state.asRequest}
              onChange={(event) => setState({ ...state, asRequest: event.target.checked, missing: false })}
            />{' '}
            {t('sendAsRequest')}
          </label>
          <div className="help__actions">
            <Button type="submit">{t('send')}</Button>
            <Button type="button" variant="ghost" onClick={() => setState({ step: 'ask' })}>
              {t('back')}
            </Button>
          </div>
        </form>
      )}
      {state.step === 'sending' && <Loading label={t('sending')} />}
      {state.step === 'done' && (
        <div role="status" data-testid="help-feedback-done">
          <p>{state.vote.earlier ? t('earlier') : state.vote.ticketId && state.askedRequest ? t('storedRequest') : t('stored')}</p>
          {state.vote.earlier && state.askedRequest && !state.vote.ticketId && (
            <p>
              {t('requestNotSent')}{' '}
              <a className="text-link" href="/support">
                {t('openDesk')}
              </a>
            </p>
          )}
          {state.vote.ticketId && (
            <a className="text-link" href={supportRequestHref(state.vote.ticketId)}>
              {t('openRequest')}
            </a>
          )}
        </div>
      )}
      {state.step === 'failed' && (
        <>
          <Failure result={state.failure} />
          <Button variant="ghost" onClick={() => setState(state.back)}>
            {t('back')}
          </Button>
        </>
      )}
      <p className="help__caption muted">{t('oneVote')}</p>
    </section>
  );
}
