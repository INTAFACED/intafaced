import { useEffect, useRef, useState } from 'react';
import { mfaResetCancelSchema as cancelSchema, mfaResetStatusSchema } from '@intafaced/contracts/identity';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { mfaResetWaitingCopy as copy } from './mfa-reset-waiting-copy';

/**
 * A waiting reset of the second step, in Security (I-signin-sessions-12, J-identity-05 #3): when it ends and a way to
 * stop it from this session. Nothing waits: the card is not drawn, since there is nothing to act on; once stopped it
 * says so until the page is left.
 */
export function MfaResetWaiting() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<'stopped' | 'gone' | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [delegated, setDelegated] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'mfaReset.status', undefined, mfaResetStatusSchema, { signal })
        : Promise.resolve({ ok: true as const, data: { waiting: null } }),
    `mfa-reset:${userId}`,
  );

  async function stop() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setDelegated(false);
    try {
      const answer = await api.mutate('identity', 'mfaReset.cancel', {}, cancelSchema);
      if (!mounted.current) return;
      if (!answer.ok) {
        if (answer.reason !== 'uncertain' && answer.code === 'identity.delegated_refused') setDelegated(true);
        else setFailure(answer);
        return;
      }
      setNote(answer.data.cancelled ? 'stopped' : 'gone');
      reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  // While the status reloads after a stop, the card stays with its note; a first load shows the spinner.
  if (resource.status === 'loading' && !note) return <Loading />;
  if (resource.status === 'failed') {
    return (
      <section
        data-testid="security__card"
        className="security__mfa-reset security__card"
        aria-label={t('title')}
        lang={languageFor('title')}
      >
        <h2>{t('title')}</h2>
        {note && (
          <p className="notice" role="status">
            {t(note)}
          </p>
        )}
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  }
  const waiting = resource.status === 'ready' ? resource.data.waiting : null;
  if (!waiting && !note) return null;
  return (
    <section
      data-testid="security__card"
      className="security__mfa-reset security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      {waiting && (
        <>
          <p role="alert">
            <strong>{t('body', { time: stamp(waiting.completesAt, timeZone) })}</strong>
          </p>
          <p className="muted">{t('asked', { time: stamp(waiting.waitingSince, timeZone) })}</p>
          <p>{t('notYou')}</p>
        </>
      )}
      {note && (
        <p className="notice" role="status">
          {t(note)}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {delegated && (
        <p className="error-text" role="alert">
          {t('refusedDelegated')}
        </p>
      )}
      {waiting && (
        <div className="row">
          <Button disabled={busy} onClick={() => void stop()}>
            {busy ? t('stopping') : t('stop')}
          </Button>
        </div>
      )}
    </section>
  );
}
