import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Field } from '../../shared/ui';
import { singleFlight } from '../../shared/password';
import { passwordCopy } from '../../shared/password-copy';
import { useSession } from '../session/session';
import { requestProblem, requestedSchema, validEmail, type RecoveryProblem } from './password-recovery';
import { handleRecoveryCopy } from './handle-recovery-copy';

/**
 * "I forgot my handle" on /findPwd (I-signin-sessions-03). The service mails the handle to the address when an account
 * uses it, and answers the same either way; a refusal that would tell the two apart reads as "on its way" here too
 * (`requestProblem`, shared with the reset request), so this page never says whether the account exists.
 */
export function HandleRecovery() {
  const { t } = handleRecoveryCopy.useCopy();
  const { t: pw } = passwordCopy.useCopy();
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<RecoveryProblem | null>(null);
  const flight = useRef(singleFlight()).current;
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const field = useRef<HTMLFormElement | null>(null);
  const problemId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  // The panel replaces its button, so focus moves to the new email field.
  useEffect(() => {
    if (open) field.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [open]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('handle-email') ?? '').trim();
    if (flight.busy) return;
    setSent(false);
    if (!validEmail(email)) {
      setProblem('invalidEmail');
      return;
    }
    await flight.run(async () => {
      setProblem(null);
      setBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      const result = await api.mutate('identity', 'auth.requestHandleRecovery', { email }, requestedSchema, { signal: controller.signal });
      if (!mounted.current) return;
      setBusy(false);
      const refused = requestProblem(result);
      setProblem(refused);
      setSent(refused === null);
    });
  }

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }
  const problemText = !problem
    ? null
    : problem === 'invalidEmail' || problem === 'codeMissing'
      ? t('invalidEmail')
      : problem === 'resetOff'
        ? t('off')
        : pw(problem);
  return (
    <section className="pub-step" aria-labelledby={`${problemId}-title`}>
      <h2 id={`${problemId}-title`}>{t('title')}</h2>
      <p className="muted">{t('body')}</p>
      <form ref={field} method="post" className="pub-form" onSubmit={ask} noValidate>
        <Field
          label={t('emailField')}
          name="handle-email"
          type="email"
          autoComplete="email"
          maxLength={320}
          required
          disabled={busy}
          aria-describedby={problemText ? problemId : undefined}
        />
        <Button type="submit" disabled={busy}>
          {busy ? t('sending') : t('send')}
        </Button>
      </form>
      {sent && (
        <p role="status" className="muted">
          {t('sent')}
        </p>
      )}
      {problemText && (
        <p id={problemId} className="pub-notice" role="alert">
          {problemText}
        </p>
      )}
    </section>
  );
}
