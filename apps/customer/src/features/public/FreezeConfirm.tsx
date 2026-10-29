import { useEffect, useRef, useState } from 'react';
import { freezeLinkRedeemSchema } from '@intafaced/contracts/identity';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { freezeConfirmCopy } from './freeze-confirm-copy';
import './public-pages.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Done = { since: string; firstUse: boolean; frozenNow: boolean };

/**
 * /freeze/confirm?token=… : the page a security notice's freeze link opens (I-account-lifecycle-08, J-identity-11 #2).
 * No sign-in: the link is the proof. Opening the page spends nothing, so a mail scanner that fetches the link does not
 * freeze the account; the person presses Freeze my account. The token leaves the address bar once read. A link used
 * before shows the result of its first use and changes nothing. A wrong or dead link is one refusal.
 */
export function FreezeConfirm() {
  const { t } = freezeConfirmCopy.useCopy();
  const { api } = useSession();
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (location.search) history.replaceState(history.state, '', location.pathname);
    return () => {
      mounted.current = false;
    };
  }, []);

  async function freeze() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const answer = await api.mutate('identity', 'freezeLink.redeem', { token }, freezeLinkRedeemSchema);
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone({ since: answer.data.since, firstUse: answer.data.firstUse, frozenNow: answer.data.frozenNow });
    else setRefusal(answer);
  }

  const dead = !token || refusal?.code === 'identity.freeze_link_invalid';
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{done ? (done.firstUse ? t('doneTitle') : t('usedTitle')) : dead ? t('deadTitle') : t('title')}</h1>
      </header>
      {done ? (
        <p role="status" data-testid="freeze-link-result" data-first-use={String(done.firstUse)} data-frozen-now={String(done.frozenNow)}>
          {done.firstUse ? t('doneBody') : t('usedBody')} <time dateTime={done.since}>{new Date(done.since).toUTCString()}</time>.{' '}
          {done.frozenNow ? null : <>{t('liftedNow')} </>}
          <a className="text-link" href="/login">
            {t('signIn')}
          </a>
        </p>
      ) : dead ? (
        <div className="pub-notice" role="alert">
          <p>{t('deadBody')}</p>
          <a className="text-link" href="/cannot-sign-in">
            {t('help')}
          </a>
        </div>
      ) : (
        <>
          <p className="muted">{t('intro')}</p>
          <Button onClick={() => void freeze()} disabled={busy}>
            {busy ? t('freezing') : t('freeze')}
          </Button>
          {refusal && <Failure result={refusal} />}
        </>
      )}
    </div>
  );
}
