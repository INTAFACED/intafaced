import { useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field } from '../../shared/ui';
import { sessionLimitsCopy as copy } from './session-limits-copy';
import { minutesOf, sessionLimitCode, sessionLimitsSchema } from './session-limits-api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Idle sign-out and the limit on signed-in devices (I-signin-sessions-06; J-identity-06 #4). Shows the owner's idle limit
 * (or that none is set), lets the person choose a shorter one, and says how many devices may be signed in at once. A
 * longer time is refused by identity, never by this page alone.
 */
export function SessionLimits() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'sessionLimits', undefined, sessionLimitsSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `session-limits:${userId}`,
  );

  async function send(seconds: number | null) {
    setBusy(true);
    setFailure(null);
    setProblem(false);
    setNote(null);
    try {
      const answer = await api.mutate('identity', 'setIdleSignOut', { seconds }, sessionLimitsSchema);
      if (!answer.ok) return setFailure(answer);
      setNote(seconds === null ? t('cleared') : t('saved', { minutes: minutesOf(seconds) }));
      reload();
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get('minutes') ?? '').trim();
    if (!/^\d+$/.test(raw)) return setProblem(true);
    void send(Number(raw) * 60);
  }

  if (resource.status !== 'ready' || !resource.data) return null;
  const state = resource.data;
  const worded = failure ? sessionLimitCode(failure.code) : undefined;
  return (
    <section
      data-testid="security__card"
      className="security__session-limits security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p data-testid="session-limits__owner">
        {state.ownerIdleSeconds === null ? t('ownerUnset') : t('ownerLimit', { minutes: minutesOf(state.ownerIdleSeconds) })}
      </p>
      {state.ownerIdleSeconds !== null && (
        <p data-testid="session-limits__chosen" className="muted">
          {state.chosenIdleSeconds === null ? t('notChosen') : t('chosen', { minutes: minutesOf(state.chosenIdleSeconds) })}
        </p>
      )}
      <p data-testid="session-limits__devices">
        {state.maxConcurrent === null ? t('devicesUnset') : t('devices', { count: state.maxConcurrent })}
      </p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure &&
        (worded ? (
          <p className="error-text" role="alert">
            {t(worded, { minutes: state.ownerIdleSeconds === null ? 0 : minutesOf(state.ownerIdleSeconds) })}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      {state.ownerIdleSeconds !== null && (
        <form className="stack" onSubmit={submit} noValidate>
          <Field label={t('field')} name="minutes" inputMode="numeric" error={problem ? t('invalid') : undefined} disabled={busy} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {t('save')}
            </Button>
            {state.chosenIdleSeconds !== null && (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void send(null)}>
                {t('clear')}
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
