import { useEffect, useRef, useState } from 'react';
import { freezeLinkRedeemSchema } from '@intafaced/contracts/identity';
import { useSession } from '../session';
import type { ApiResult } from '../../shared/api';
import { Button, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { Failed } from './Failed';
import { freezeConfirmCopy } from './freeze-confirm-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Done = { since: string; firstUse: boolean; frozenNow: boolean };

/**
 * /freeze/confirm#token=… : the page a security notice's freeze link opens (I-account-lifecycle-08, J-identity-11 #2).
 * No sign-in: the link is the proof. Opening the page spends nothing, so a mail scanner that fetches the link does not
 * freeze the account; the person presses Freeze my account. The token rides in the fragment, so no server log or
 * Referer ever carries it, and it leaves the address bar once read. A link used
 * before shows the result of its first use and changes nothing. A wrong or dead link is one refusal.
 */
export function FreezeConfirm() {
  const { t } = freezeConfirmCopy.useCopy();
  const { api } = useSession();
  const token = useRef(new URLSearchParams(location.hash.slice(1)).get('token')?.trim() ?? '').current;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (location.hash || location.search) history.replaceState(history.state, '', location.pathname);
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
    <FlowTemplate
      title={done ? (done.firstUse ? t('doneTitle') : t('usedTitle')) : dead ? t('deadTitle') : t('title')}
      description={t('eyebrow')}
      state={{ kind: 'ready' }}
      step={
        done ? (
          <p role="status" data-testid="freeze-link-result" data-first-use={String(done.firstUse)} data-frozen-now={String(done.frozenNow)}>
            {done.firstUse ? t('doneBody') : t('usedBody')} <time dateTime={done.since}>{new Date(done.since).toUTCString()}</time>.{' '}
            {done.frozenNow ? null : <>{t('liftedNow')} </>}
            <a className="lt-link" href="/login">
              {t('signIn')}
            </a>
          </p>
        ) : dead ? (
          <RefusalBox
            refusal={{ variant: 'refused', title: t('deadBody'), body: '', action: { label: t('help'), href: '/cannot-sign-in' } }}
            role="alert"
          />
        ) : (
          <>
            <p>{t('intro')}</p>
            <Button tone="primary" onClick={() => void freeze()} disabled={busy}>
              {busy ? t('freezing') : t('freeze')}
            </Button>
            {refusal && <Failed result={refusal} />}
          </>
        )
      }
    />
  );
}
