import { useEffect, useRef, useReducer, type FormEvent } from 'react';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { MAX_INPUT_LENGTH, singleFlight } from '../../shared/password';
import { passwordCopy } from '../../shared/password-copy';
import { changeIssue, changeReducer, changedSchema, initialChange } from './change-password';
import { changePasswordCopy } from './change-password-copy';

/**
 * The change-password card in Security. Passwords are read from the form when it is sent and cleared straight
 * after; they are never held in state, storage or logs.
 */
export function ChangePassword({ onChanged }: { onChanged?: () => void }) {
  const { t, languageFor } = changePasswordCopy.useCopy();
  const { t: pw } = passwordCopy.useCopy();
  const { api, userId } = useSession();
  const [state, dispatch] = useReducer(changeReducer, initialChange);
  const flight = useRef(singleFlight()).current;
  const form = useRef<HTMLFormElement | null>(null);
  const owner = useRef(userId);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  owner.current = userId;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    abort.current = controller;
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  function wipe(...names: string[]) {
    for (const name of names) {
      const input = form.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = '';
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const current = String(data.get('current-password') ?? '');
    const next = String(data.get('new-password') ?? '');
    const confirm = String(data.get('confirm-password') ?? '');
    if (flight.busy || state.phase === 'sending') return;
    const issue = changeIssue(current, next, confirm);
    if (issue) {
      dispatch({ type: 'submit', issue });
      if (issue === 'mismatch') wipe('confirm-password');
      return;
    }
    const startedFor = userId;
    const answered = await flight.run(async () => {
      dispatch({ type: 'submit', issue: null });
      return api.mutate('identity', 'auth.changePassword', { currentPassword: current, newPassword: next }, changedSchema, {
        signal: abort.current?.signal,
      });
    });
    // Whatever the answer, nothing typed stays in the page: the person retypes after a refusal.
    wipe('current-password', 'new-password', 'confirm-password');
    if (!answered || !mounted.current || owner.current !== startedFor) return;
    dispatch({ type: 'answered', result: answered });
    if (answered.ok) onChanged?.();
  }

  const sending = state.phase === 'sending';
  const problem = state.phase === 'idle' ? state.problem : null;
  const problemText = problem ? (problem === 'currentMissing' ? t('currentMissing') : pw(problem)) : null;
  return (
    <section
      data-testid="security__password"
      className="security__password security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      {state.phase === 'changed' ? (
        <div className="stack">
          <p data-testid="notice" className="notice" role="status">
            {t('changed')}
          </p>
          <Button variant="secondary" onClick={() => dispatch({ type: 'again' })}>
            {t('again')}
          </Button>
        </div>
      ) : (
        <form ref={form} method="post" className="stack" onSubmit={(event) => void submit(event)} noValidate>
          <Field
            label={t('currentField')}
            name="current-password"
            type="password"
            autoComplete="current-password"
            maxLength={MAX_INPUT_LENGTH}
            required
            disabled={sending}
            data-security-sensitive="true"
          />
          <Field
            label={t('newField')}
            name="new-password"
            type="password"
            autoComplete="new-password"
            hint={pw('hint')}
            maxLength={MAX_INPUT_LENGTH}
            required
            disabled={sending}
            data-security-sensitive="true"
          />
          <Field
            label={t('confirmField')}
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            maxLength={MAX_INPUT_LENGTH}
            required
            disabled={sending}
            data-security-sensitive="true"
          />
          {problemText && (
            <p className="error-text" role="alert">
              {problemText}
            </p>
          )}
          <Button type="submit" disabled={sending}>
            {sending ? t('sending') : t('submit')}
          </Button>
        </form>
      )}
    </section>
  );
}
