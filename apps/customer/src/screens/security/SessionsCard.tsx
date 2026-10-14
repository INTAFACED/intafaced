import { Monitor } from 'lucide-react';
import {
  Button,
  Card,
  Chip,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  sessionNotesCopy,
  Note,
  refusalCopy,
  Row,
  Rows,
  StateBlock,
  stamp,
  usePreferences,
  useSession,
} from './deps';
import { securityScreenCopy } from './copy';
import { thisSessionId } from './this-session';
import { useSessions } from './use-sessions';

/**
 * Where you're signed in: every live session, a sign-out for each, and sign-out-everywhere (which the page owns, because it
 * has its own saved note). `readOnly` keeps the list visible but blocks sign-outs while a sign-out-everywhere is unconfirmed.
 */
export function SessionsCard({
  readOnly,
  onSignOutEverywhere,
  signOutEverywhereDisabled,
}: {
  readOnly: boolean;
  onSignOutEverywhere: () => void;
  signOutEverywhereDisabled: boolean;
}) {
  const { t } = securityScreenCopy.useCopy();
  const w = sessionNotesCopy.useCopy().t;
  const { timeZone } = usePreferences();
  const { session } = useSession();
  const mine = thisSessionId(session?.accessToken);
  const flow = useSessions();
  const { resource, reload, review, busy, journal, blocked, problem, result, knownGuard, limit, setLimit } = flow;
  const seats = resource.status === 'ready' && resource.data ? resource.data.sessions : [];
  const reviewingMine = review ? review.seat.id.toLowerCase() === mine : false;

  return (
    <Card
      title={t('Where signed in')}
      lead={t('Where lead')}
      action={
        <Button variant="secondary" size={32} disabled={busy} onClick={reload}>
          {t('Refresh')}
        </Button>
      }
    >
      {journal.marker ? (
        <Note tone="warn" role="status">
          <h3 className="sk-h3">{w(busy ? 'sending' : knownGuard ? 'guardRetained' : 'unknown')}</h3>
          <p>{w(knownGuard ? 'guardBody' : 'unknownBody')}</p>
          <p>{w('lookup')}</p>
          <details>
            <summary>{t('Reference')}</summary>
            <p className="sk-mono">{journal.marker.seat.id}</p>
          </details>
          <a className="sk-link" href="/support">
            {w('support')}
          </a>
        </Note>
      ) : null}
      {problem || journal.failed ? (
        <Note tone="warn" role="status">
          <p>{w(journal.failed ? 'storage' : problem!)}</p>
        </Note>
      ) : null}

      <fieldset className="sec-fieldset" disabled={readOnly}>
        {resource.status === 'loading' ? (
          <StateBlock kind="loading" rows={3} rowHeight={56} label={t('Where signed in')} />
        ) : resource.status === 'failed' ? (
          resource.failure.code && (resource.failure.reason === 'forbidden' || resource.failure.reason === 'error') ? (
            (() => {
              const words = refusalCopy(resource.failure.code);
              return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
            })()
          ) : (
            <StateBlock kind="error" title={t('Could not load')} onRetry={reload} retryLabel={t('Try again')} />
          )
        ) : seats.length === 0 ? (
          <StateBlock kind="empty" title={t('No sessions')} body={t('No sessions body')} />
        ) : (
          <div className="sec-scroll">
            <Rows label={t('Where signed in')}>
              {seats.map((seat) => (
                <Row
                  key={seat.id}
                  icon={<Monitor size={20} strokeWidth={1.75} />}
                  title={t('Signed in at', { time: stamp(seat.createdAt, timeZone) })}
                  chip={seat.id.toLowerCase() === mine ? <Chip tone="good">{t('This device')}</Chip> : null}
                  action={
                    <Button
                      variant="secondary"
                      size={32}
                      disabled={blocked || readOnly}
                      aria-label={`${t('Sign out')}: ${t('Signed in at', { time: stamp(seat.createdAt, timeZone) })}`}
                      onClick={() => flow.open(seat)}
                    >
                      {t('Sign out')}
                    </Button>
                  }
                />
              ))}
            </Rows>
          </div>
        )}
      </fieldset>

      {resource.status === 'ready' && seats.length >= limit && limit < 200 ? (
        <div className="sec-actions">
          <Button variant="ghost" size={32} disabled={busy} onClick={() => setLimit((value) => Math.min(200, value + 50))}>
            {t('Show more')}
          </Button>
        </div>
      ) : null}

      {result ? (
        result.answer.ok ? (
          <Note tone={result.answer.data.revoked ? 'good' : undefined} role="status">
            <p>{w(result.answer.data.revoked ? 'revoked' : 'unchanged')}</p>
          </Note>
        ) : (
          <Note tone="error" role="alert">
            <p>{result.answer.reason === 'uncertain' ? w('unknownBody') : t('Could not load')}</p>
          </Note>
        )
      ) : null}

      <div className="sec-everywhere">
        <div className="sk-row__text">
          <span className="sk-row__title">{t('Sign out everywhere')}</span>
          <span className="sk-row__line">{t('Sign out everywhere line')}</span>
        </div>
        <Button variant="sell" size={40} disabled={signOutEverywhereDisabled} onClick={onSignOutEverywhere}>
          {t('Sign out everywhere')}
        </Button>
      </div>

      <Dialog
        open={review !== null && review.owner === flow.userId}
        onOpenChange={(next) => {
          if (!next) flow.cancelReview();
        }}
      >
        <DialogContent closeLabel={t('Close')}>
          <div className="sk-dialog">
            <DialogHeader>
              <DialogTitle>{t('Review session title')}</DialogTitle>
              <DialogDescription>{reviewingMine ? t('Review session own') : t('Review session body')}</DialogDescription>
            </DialogHeader>
            {review ? <p className="sk-small">{t('Signed in at', { time: stamp(review.seat.createdAt, timeZone) })}</p> : null}
            <DialogFooter>
              <Button variant="ghost" size={40} disabled={busy} onClick={flow.cancelReview}>
                {t('Cancel')}
              </Button>
              <Button variant="sell" size={40} disabled={blocked} onClick={() => void flow.revoke()}>
                {t('Sign out')}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
