import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';
import type { ApiResult } from '../../shared/api';
import { Button, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { Failed } from './Failed';
import { confirmEmailCopy } from './confirm-email-copy';
import { IDENTITY_AUTH_CONFIRM_EMAIL } from '@intafaced/contracts/identity-auth-procedures';

// hand-declared-ok: svc-identity's auth.confirmEmail answer has no browser-safe schema in packages/contracts yet

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
    const answer = await api.call(IDENTITY_AUTH_CONFIRM_EMAIL, { token });
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone(true);
    else setRefusal(answer);
  }

  // A link that ran out and one already used are named apart; a missing or unknown token is the general dead link.
  const dead: 'expired' | 'used' | 'dead' | null =
    refusal?.code === 'auth.email_confirm_expired'
      ? 'expired'
      : refusal?.code === 'auth.email_confirm_used'
        ? 'used'
        : !token || refusal?.code === 'auth.email_confirm_invalid'
          ? 'dead'
          : null;
  return (
    <FlowTemplate
      title={done ? t('doneTitle') : dead ? t(`${dead}Title`) : t('title')}
      description={t('eyebrow')}
      state={{ kind: 'ready' }}
      step={
        done ? (
          <p role="status">
            {t('doneBody')}{' '}
            <a className="lt-link" href="/uc/account">
              {t('toAccount')}
            </a>
          </p>
        ) : dead ? (
          <RefusalBox
            refusal={{ variant: 'refused', title: t(`${dead}Body`), body: '', action: { label: t('toAccount'), href: '/uc/account' } }}
            role="alert"
          />
        ) : (
          <>
            <p>{t('intro')}</p>
            <Button tone="primary" onClick={() => void confirm()} disabled={busy}>
              {busy ? t('confirming') : t('confirm')}
            </Button>
            {refusal?.code === 'auth.email_confirm_unwired' ? (
              <RefusalBox refusal={{ variant: 'refused', title: t('unwired'), body: '', reference: refusal.code }} role="alert" />
            ) : (
              refusal && <Failed result={refusal} />
            )}
          </>
        )
      }
    />
  );
}
