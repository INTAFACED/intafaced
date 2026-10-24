import { useEffect, useRef, useState } from 'react';
import { supportRecoveryRedeemSchema } from '@intafaced/contracts/identity';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { supportRecoveryCopy } from './support-recovery-copy';
import './public-pages.css';

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
    const answer = await api.mutate('identity', 'supportRecovery.redeem', { token }, supportRecoveryRedeemSchema);
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone(true);
    else setRefusal(answer);
  }

  const dead = !token || refusal?.code === 'identity.support_recovery_link_invalid';
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{done ? t('doneTitle') : dead ? t('deadTitle') : t('recoverTitle')}</h1>
      </header>
      {done ? (
        <p role="status">
          {t('doneBody')}{' '}
          <a className="text-link" href="/login">
            {t('signIn')}
          </a>
        </p>
      ) : dead ? (
        <div className="pub-notice" role="alert">
          <p>{t('deadBody')}</p>
          <a className="text-link" href="/cannot-sign-in">
            {t('link')}
          </a>
        </div>
      ) : (
        <>
          <p className="muted">{t('recoverIntro')}</p>
          <Button onClick={() => void recover()} disabled={busy}>
            {busy ? t('recovering') : t('recover')}
          </Button>
          {refusal?.code === 'identity.security_locked' ? (
            <p className="pub-notice" role="alert">
              {t('locked')} <small lang="zxx">{refusal.code}</small>
            </p>
          ) : refusal?.code === 'auth.codes_unwired' ? (
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
