import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Failure, Field } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { singleFlight } from '../../shared/password';
import { useSession } from '../session/session';
import { requestedSchema, validEmail } from './password-recovery';
import { handleRecoveryCopy } from './handle-recovery-copy';

type Answer = ApiResult<{ accepted: true }>;

/**
 * "I forgot my handle" on /findPwd (I-signin-sessions-03). The service mails the handle to the address when an account
 * uses it, and answers the same either way, so this page never says whether the account exists.
 */
export function HandleRecovery() {
  const { t } = handleRecoveryCopy.useCopy();
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const flight = useRef(singleFlight()).current;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('handle-email') ?? '').trim();
    if (flight.busy) return;
    if (!validEmail(email)) {
      setInvalid(true);
      return;
    }
    await flight.run(async () => {
      setInvalid(false);
      setBusy(true);
      setAnswer(null);
      const result = await api.mutate('identity', 'auth.requestHandleRecovery', { email }, requestedSchema);
      if (!mounted.current) return;
      setBusy(false);
      setAnswer(result);
    });
  }

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }
  return (
    <section className="pub-step" aria-labelledby="handle-recovery-title">
      <h2 id="handle-recovery-title">{t('title')}</h2>
      <p className="muted">{t('body')}</p>
      <form method="post" className="pub-form" onSubmit={ask} noValidate>
        <Field
          label={t('emailField')}
          name="handle-email"
          type="email"
          autoComplete="email"
          maxLength={320}
          required
          disabled={busy}
          error={invalid ? t('invalidEmail') : undefined}
        />
        <Button type="submit" disabled={busy}>
          {busy ? t('sending') : t('send')}
        </Button>
      </form>
      {answer?.ok && (
        <p role="status" className="muted">
          {t('sent')}
        </p>
      )}
      {answer && !answer.ok && (
        <div className="pub-notice" role="alert">
          {answer.code === 'auth.reset_unwired' ? <p>{t('off')}</p> : <Failure result={answer} />}
          {answer.code && <small lang="zxx">{answer.code}</small>}
        </div>
      )}
    </section>
  );
}
