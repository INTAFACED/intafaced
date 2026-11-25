// volt-room: /recover-account
import { useEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import type { ApiResult } from '../../shared/api';
import { FailureNote } from '../../shared/failure-note';
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
          <div className="lt-refusal" role="alert">
            <p className="lt-refusal-body">{t('deadBody')}</p>
            <a className="lt-link" href="/cannot-sign-in">
              {t('link')}
            </a>
          </div>
        ) : (
          <div className="lt-stack">
            <p className="lt-muted">{t('recoverIntro')}</p>
            <div className="lt-actions">
              <Button tone="primary" onClick={() => void recover()} disabled={busy}>
                {busy ? t('recovering') : t('recover')}
              </Button>
            </div>
            {refusal?.code === 'identity.security_locked' ? (
              <p className="lt-refusal" role="alert">
                {t('locked')} <small lang="zxx">{refusal.code}</small>
              </p>
            ) : refusal?.code === 'auth.codes_unwired' ? (
              <p className="lt-refusal" role="alert">
                {t('unwired')} <small lang="zxx">{refusal.code}</small>
              </p>
            ) : (
              refusal && <FailureNote result={refusal} />
            )}
          </div>
        )
      }
    />
  );
}
