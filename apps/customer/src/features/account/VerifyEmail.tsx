import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { fetchMe } from '../../data/identity';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Field } from '../../shared/ui';
import { verifyEmailCopy } from './verify-email-copy';

// hand-declared-ok: svc-identity's auth.requestEmailConfirmation and auth.confirmEmailCode answers have no browser-safe schema in packages/contracts yet
const acceptedSchema = z.object({ accepted: z.literal(true) });
const confirmedSchema = z.object({ confirmed: z.literal(true) });

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Status = 'unknown' | 'verified' | 'unverified';

/** The refusals this banner words itself; anything else falls back to the shared failure card. */
const WORDED = new Set([
  'auth.email_confirm_rate_limited',
  'auth.email_confirm_resend_too_soon',
  'auth.email_confirm_code_invalid',
  'auth.email_confirm_code_locked',
  'auth.email_confirm_expired',
  'auth.email_confirm_used',
  'auth.email_confirm_unwired',
  'vendor.email',
]);

/**
 * The "verify your email" banner on Account (I-kyc-compliance-18, J-identity-01 #7). It shows only when the service says
 * the address is unproved, sends the mail (`auth.requestEmailConfirmation`) and takes the six-digit code from it
 * (`auth.confirmEmailCode`); the mail's link does the same, and "check again" reads the answer after a link was used.
 * An early resend is refused with the seconds left; with no mail transport the notice names it. A server that does not
 * report confirmation shows nothing rather than a guess.
 */
export function VerifyEmail() {
  const { t } = verifyEmailCopy.useCopy();
  const { api, userId } = useSession();
  const [status, setStatus] = useState<Status>('unknown');
  const [busy, setBusy] = useState<'send' | 'check' | 'code' | null>(null);
  const [sent, setSent] = useState(false);
  const [still, setStill] = useState(false);
  const [unread, setUnread] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [missing, setMissing] = useState(false);
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

  function clear() {
    setRefusal(null);
    setStill(false);
    setMissing(false);
  }

  async function send() {
    if (busy) return;
    setBusy('send');
    clear();
    const answer = await api.mutate('identity', 'auth.requestEmailConfirmation', undefined, acceptedSchema);
    if (!mounted.current) return;
    setBusy(null);
    if (answer.ok) setSent(true);
    else setRefusal(answer);
  }

  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = event.currentTarget.elements.namedItem('code');
    const code = input instanceof HTMLInputElement ? input.value.trim() : '';
    clear();
    if (!/^\d{6}$/.test(code)) {
      setMissing(true);
      return;
    }
    setBusy('code');
    const answer = await api.mutate('identity', 'auth.confirmEmailCode', { code }, confirmedSchema);
    if (!mounted.current) return;
    setBusy(null);
    if (answer.ok) setStatus('verified');
    else {
      if (input instanceof HTMLInputElement) input.value = '';
      setRefusal(answer);
    }
  }

  async function check() {
    if (busy) return;
    setBusy('check');
    clear();
    setUnread(false);
    const me = await fetchMe(api);
    if (!mounted.current) return;
    setBusy(null);
    if (me.kind !== 'ok' || me.userId !== userId) setUnread(true);
    else if (me.emailVerified === true) setStatus('verified');
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
  const seconds = refusal?.retryAfterSeconds;
  const problem = missing
    ? t('codeMissing')
    : code === 'auth.email_confirm_rate_limited'
      ? seconds
        ? t('auth.email_confirm_rate_limited', { minutes: Math.max(1, Math.ceil(seconds / 60)) })
        : t('auth.email_confirm_rate_limited_plain')
      : code === 'auth.email_confirm_resend_too_soon'
        ? seconds
          ? t('auth.email_confirm_resend_too_soon', { seconds })
          : t('auth.email_confirm_resend_too_soon_plain')
        : code && WORDED.has(code)
          ? t(code as 'vendor.email')
          : null;
  return (
    <section className="notice verify-email" aria-labelledby="verify-email-title">
      <h2 id="verify-email-title">{t('title')}</h2>
      <p>{t('body')}</p>
      {sent && <p role="status">{t('sent')}</p>}
      {still && <p role="status">{t('stillUnverified')}</p>}
      {unread && <p role="alert">{t('unread')}</p>}
      {problem ? (
        <p role="alert">
          {problem} {code && <small lang="zxx">{code}</small>}
        </p>
      ) : (
        refusal && <Failure result={refusal} />
      )}
      {/* The code field stays, so a code mailed before a reload or a later visit can still be typed; it goes only when
          no mail can be sent at all. */}
      {code !== 'vendor.email' && code !== 'auth.email_confirm_unwired' && (
        <form className="verify-email__code" onSubmit={(event) => void enter(event)}>
          <Field
            label={t('code')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            disabled={busy !== null}
          />
          <Button type="submit" disabled={busy !== null}>
            {busy === 'code' ? t('confirming') : t('confirm')}
          </Button>
        </form>
      )}
      <Button variant={sent ? 'secondary' : undefined} onClick={() => void send()} disabled={busy !== null}>
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
