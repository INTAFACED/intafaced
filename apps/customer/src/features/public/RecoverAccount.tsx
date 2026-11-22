// volt-room: /recover-account
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';
import type { ApiResult } from '../../shared/api';
import { Button, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { Failed } from './Failed';
import { supportRecoveryCopy } from './support-recovery-copy';
import { IDENTITY_SUPPORT_RECOVERY_REDEEM } from '@intafaced/contracts/identity-support-recovery-procedures';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * /recover-account?token=… : the page Support's one-time recovery link opens (I-signin-sessions-24, J-identity-05 #5).
 * Opening the page spends nothing, so a mail scanner that fetches the link does not use it up; the person presses Recover.
 * The token leaves the address bar once read and is never shown. A wrong, used, expired or closed link is one refusal.
 */
export function RecoverAccount() {
  const { t } = supportRecoveryCopy.useCopy();
  const { api } = useSession();
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (location.search) history.replaceState(history.state, '', location.pathname);
    return () => {
      mounted.current = false;
    };
  }, []);

  async function recover() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const answer = await api.call(IDENTITY_SUPPORT_RECOVERY_REDEEM, { token });
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone(true);
    else setRefusal(answer);
  }

  const dead = !token || refusal?.code === 'identity.support_recovery_link_invalid';
  return (
    <FlowTemplate
      title={done ? t('doneTitle') : dead ? t('deadTitle') : t('recoverTitle')}
      description={t('eyebrow')}
      state={{ kind: 'ready' }}
      step={
        done ? (
          <p role="status">
            {t('doneBody')}{' '}
            <a className="lt-link" href="/login">
              {t('signIn')}
            </a>
          </p>
        ) : dead ? (
          <RefusalBox
            refusal={{ variant: 'refused', title: t('deadBody'), body: '', action: { label: t('link'), href: '/cannot-sign-in' } }}
            role="alert"
          />
        ) : (
          <>
            <p>{t('recoverIntro')}</p>
            <Button tone="primary" onClick={() => void recover()} disabled={busy}>
              {busy ? t('recovering') : t('recover')}
            </Button>
            {refusal?.code === 'identity.security_locked' ? (
              <RefusalBox refusal={{ variant: 'refused', title: t('locked'), body: '', reference: refusal.code }} role="alert" />
            ) : refusal?.code === 'auth.codes_unwired' ? (
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
