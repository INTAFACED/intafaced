import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { fetchMe } from '../../data/identity';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { verifyEmailCopy } from './verify-email-copy';

// hand-declared-ok: svc-identity's auth.requestEmailConfirmation answer has no browser-safe schema in packages/contracts yet
const acceptedSchema = z.object({ accepted: z.literal(true) });

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Status = 'unknown' | 'verified' | 'unverified';

/**
 * The "verify your email" banner on Account (I-kyc-compliance-18). It shows only when the service says the address is
 * unproved, sends the link (`auth.requestEmailConfirmation`), and reads the answer again when the person comes back.
 * A server that does not report confirmation shows nothing rather than a guess.
 */
export function VerifyEmail() {
  const { t } = verifyEmailCopy.useCopy();
  const { api, userId } = useSession();
  const [status, setStatus] = useState<Status>('unknown');
  const [busy, setBusy] = useState<'send' | 'check' | null>(null);
  const [sent, setSent] = useState(false);
  const [still, setStill] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void fetchMe(api, controller.signal).then((me) => {
      if (controller.signal.aborted || me.kind !== 'ok' || me.userId !== userId || me.emailVerified === undefined) return;
      setStatus(me.emailVerified ? 'verified' : 'unverified');
    });
    return () => controller.abort();
  }, [api, userId]);

  async function send() {
    if (busy) return;
    setBusy('send');
    setRefusal(null);
    setStill(false);
    const answer = await api.mutate('identity', 'auth.requestEmailConfirmation', undefined, acceptedSchema);
    if (!mounted.current) return;
    setBusy(null);
    if (answer.ok) setSent(true);
    else setRefusal(answer);
  }

  async function check() {
    if (busy) return;
    setBusy('check');
    setRefusal(null);
    const me = await fetchMe(api);
    if (!mounted.current) return;
    setBusy(null);
    if (me.kind === 'ok' && me.userId === userId && me.emailVerified === true) setStatus('verified');
    else setStill(true);
  }

  if (status === 'unknown') return null;
  if (status === 'verified') {
    return (
      <section className="subaccounts__identity" aria-label={t('label')}>
        <p role="status">{t('verified')}</p>
      </section>
    );
  }
  const code = refusal?.code;
  const problem =
    code === 'auth.email_confirm_rate_limited'
      ? refusal?.retryAfterSeconds
        ? t('auth.email_confirm_rate_limited', { minutes: Math.max(1, Math.ceil(refusal.retryAfterSeconds / 60)) })
        : t('auth.email_confirm_rate_limited_plain')
      : code === 'auth.email_confirm_unwired'
        ? t('auth.email_confirm_unwired')
        : null;
  return (
    <section className="notice verify-email" aria-labelledby="verify-email-title">
      <h2 id="verify-email-title">{t('title')}</h2>
      <p>{t('body')}</p>
      {sent && <p role="status">{t('sent')}</p>}
      {still && <p role="status">{t('stillUnverified')}</p>}
      {problem ? (
        <p role="alert">
          {problem} <small lang="zxx">{code}</small>
        </p>
      ) : (
        refusal && <Failure result={refusal} />
      )}
      <Button onClick={() => void send()} disabled={busy !== null}>
        {busy === 'send' ? t('sending') : t('send')}
      </Button>{' '}
      {sent && (
        <Button variant="secondary" onClick={() => void check()} disabled={busy !== null}>
          {busy === 'check' ? t('checking') : t('check')}
        </Button>
      )}
    </section>
  );
}
