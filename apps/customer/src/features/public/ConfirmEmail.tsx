import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { confirmEmailCopy } from './confirm-email-copy';
import './public-pages.css';

// hand-declared-ok: svc-identity's auth.confirmEmail answer has no browser-safe schema in packages/contracts yet
const confirmedSchema = z.object({ confirmed: z.literal(true) });

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * /confirm-email?token=… : the page the confirmation email links to (I-kyc-compliance-18, I-signin-sessions-32). Nothing
 * is spent on opening the page, so a mail scanner that fetches the link does not use it up; the person presses
 * Confirm. A wrong, expired or used link is one refusal from the service, shown as a page with the next step and never
 * the token itself.
 */
export function ConfirmEmail() {
  const { t } = confirmEmailCopy.useCopy();
  const { api } = useSession();
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // The token stays out of the address bar and history once read.
    if (location.search) history.replaceState(history.state, '', location.pathname);
    return () => {
      mounted.current = false;
    };
  }, []);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const answer = await api.mutate('identity', 'auth.confirmEmail', { token }, confirmedSchema);
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone(true);
    else setRefusal(answer);
  }

  const dead = !token || refusal?.code === 'auth.email_confirm_invalid';
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{done ? t('doneTitle') : dead ? t('deadTitle') : t('title')}</h1>
      </header>
      {done ? (
        <p role="status">
          {t('doneBody')}{' '}
          <a className="text-link" href="/uc/account">
            {t('toAccount')}
          </a>
        </p>
      ) : dead ? (
        <div className="pub-notice" role="alert">
          <p>{t('deadBody')}</p>
          <a className="text-link" href="/uc/account">
            {t('toAccount')}
          </a>
        </div>
      ) : (
        <>
          <p className="muted">{t('intro')}</p>
          <Button onClick={() => void confirm()} disabled={busy}>
            {busy ? t('confirming') : t('confirm')}
          </Button>
          {refusal?.code === 'auth.email_confirm_unwired' ? (
            <p className="pub-notice" role="alert">
              {t('unwired')} <small lang="zxx">{refusal.code}</small>
            </p>
          ) : (
            refusal && <Failure result={refusal} />
          )}
        </>
      )}
    </div>
  );
}
