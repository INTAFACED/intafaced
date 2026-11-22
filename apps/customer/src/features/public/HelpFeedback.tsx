import { useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, TextField } from '@intafaced/ui/lit';
import { CheckField } from '@intafaced/ui/lit/templates';
import { safeReturnTo } from '../../app/navigation';
import { useSession } from '../session';
import { FailureNote, Waiting, sendArticleFeedback, supportRequestHref } from '../more';
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
      <section className="lt-stack" aria-label={t('question')} data-testid="help-feedback">
        <h2>{t('question')}</h2>
        <p className="lt-hint">{t('signedOut')}</p>
        <a
          className="lt-button lt-button-secondary"
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
    <section className="lt-stack" aria-label={t('question')} data-testid="help-feedback">
      <h2>{t('question')}</h2>
      {state.step === 'ask' && (
        <div className="lt-actions">
          <Button tone="secondary" onClick={() => void send(true)}>
            {t('yes')}
          </Button>
          <Button tone="secondary" onClick={() => setState({ step: 'comment', comment: '', asRequest: false, missing: false })}>
            {t('no')}
          </Button>
        </div>
      )}
      {state.step === 'comment' && (
        <form
          className="lt-stack"
          onSubmit={(event) => {
            event.preventDefault();
            const comment = state.comment.trim();
            if (state.asRequest && !comment) return setState({ ...state, missing: true });
            void send(false, comment, state.asRequest, state);
          }}
        >
          <TextField
            label={t('commentLabel')}
            name="help-feedback-comment"
            value={state.comment}
            maxLength={2000}
            rows={3}
            aria-invalid={state.missing}
            error={state.missing ? t('requestNeedsComment') : undefined}
            onChange={(event) => setState({ ...state, comment: event.target.value, missing: false })}
          />
          <CheckField
            label={t('sendAsRequest')}
            checked={state.asRequest}
            onChange={(checked) => setState({ ...state, asRequest: checked, missing: false })}
          />
          <div className="lt-actions">
            <Button type="submit" tone="primary">
              {t('send')}
            </Button>
            <Button type="button" tone="quiet" onClick={() => setState({ step: 'ask' })}>
              {t('back')}
            </Button>
          </div>
        </form>
      )}
      {state.step === 'sending' && <Waiting label={t('sending')} />}
      {state.step === 'done' && (
        <div role="status" data-testid="help-feedback-done">
          <p>{state.vote.earlier ? t('earlier') : state.vote.ticketId && state.askedRequest ? t('storedRequest') : t('stored')}</p>
          {state.vote.earlier && state.askedRequest && !state.vote.ticketId && (
            <p>
              {t('requestNotSent')}{' '}
              <a className="lt-link" href="/support">
                {t('openDesk')}
              </a>
            </p>
          )}
          {state.vote.ticketId && (
            <a className="lt-link lt-link-alone" href={supportRequestHref(state.vote.ticketId)}>
              {t('openRequest')}
            </a>
          )}
        </div>
      )}
      {state.step === 'failed' && (
        <>
          <FailureNote result={state.failure} />
          <Button tone="quiet" onClick={() => setState(state.back)}>
            {t('back')}
          </Button>
        </>
      )}
      <p className="lt-hint">{t('oneVote')}</p>
    </section>
  );
}
