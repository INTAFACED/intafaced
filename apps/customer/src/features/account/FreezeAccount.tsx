import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { selfFreezeCopy as copy } from './self-freeze-copy';
import { FREEZE_REASONS, FREEZE_REFUSAL_KEYS, REASON_KEYS, freezeDone, freezeStatus, type FreezeReason } from './self-freeze';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Freeze account in Security (slice I-account-lifecycle-08): the person's own freeze. It needs the current password and a reason,
 * signs out every device and key, and moves no money. The page says so before the button and shows "You froze this account"
 * afterwards. Lifting the freeze is its own slice and is not offered here.
 */
export function FreezeAccount() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<FreezeReason>('compromise');
  const [problem, setProblem] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const status = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'auth.selfFreezeStatus', undefined, freezeStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `self-freeze:${userId}`,
  );

  async function freeze(password: string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'auth.selfFreeze', { reason, password }, freezeDone);
      if (!mounted.current) return;
      if (!answer.ok) return setFailure(answer);
      setNote(t('frozenNote'));
      status.reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('freeze-password') ?? '');
    if (password.length === 0) return setProblem(true);
    setProblem(false);
    form.current?.reset();
    void freeze(password);
  }

  if (status.resource.status === 'loading') return <Loading />;
  if (status.resource.status === 'failed') return <Failure result={status.resource.failure} retry={status.reload} />;
  if (!status.resource.data) return null;
  const current = status.resource.data;

  if (current.frozen && current.since && current.reason) {
    return (
      <section
        data-testid="security__card"
        className="security__freeze security__card"
        aria-label={t('frozenTitle')}
        lang={languageFor('frozenTitle')}
      >
        <h2>{t('frozenTitle')}</h2>
        {note && (
          <p className="notice" role="status">
            {note}
          </p>
        )}
        <p>{t('frozenBody', { date: stamp(current.since, timeZone), reason: t(REASON_KEYS[current.reason] as 'reasonPersonal') })}</p>
      </section>
    );
  }

  const refusal = failure && failure.code ? FREEZE_REFUSAL_KEYS[failure.code] : undefined;
  return (
    <section data-testid="security__card" className="security__freeze security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p>{t('consequences')}</p>
      {failure &&
        (refusal ? (
          <p className="notice" role="alert">
            {t(refusal as 'refusedPassword')}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <form ref={form} method="post" className="stack" onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          <legend>{t('reasonLabel')}</legend>
          {FREEZE_REASONS.map((value) => (
            <label key={value} className="row">
              <input type="radio" name="freeze-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />{' '}
              {t(REASON_KEYS[value] as 'reasonPersonal')}
            </label>
          ))}
        </fieldset>
        <Field
          label={t('passwordField')}
          name="freeze-password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          error={problem ? t('passwordNeeded') : undefined}
          data-security-sensitive="true"
        />
        <div className="actions">
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? t('working') : t('freezeAsk')}
          </Button>
        </div>
      </form>
    </section>
  );
}
