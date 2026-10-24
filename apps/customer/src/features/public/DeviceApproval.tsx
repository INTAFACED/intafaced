import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Failure, Field } from '../../shared/ui';
import type { ApiResult, DeviceAuthorisation } from '../../shared/api';
import { sessionSchema, useSession, type Session } from '../session/session';
import { validAuthSession } from './public-auth-guards';
import { deviceApprovalCopy } from './device-approval-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const WORDED = [
  'auth.code_invalid',
  'auth.code_expired',
  'auth.too_many_attempts',
  'auth.device_authorisation_invalid',
  'auth.device_authorisation_used',
  'auth.device_authorisation_pending',
] as const;
type Worded = (typeof WORDED)[number];
const worded = (code: string | undefined): code is Worded => (WORDED as readonly string[]).includes(code ?? '');
/** Refusals after which this request can never sign in: the person starts over. */
const FINAL = new Set([
  'auth.code_expired',
  'auth.too_many_attempts',
  'auth.device_authorisation_invalid',
  'auth.device_authorisation_used',
]);
const POLL_MS = 4000;

/**
 * "Authorise this device" on /login (I-signin-sessions-07, J-identity-02 #5). Shown after every factor passed on a
 * browser with no trusted device for the account. The mailed code approves it here; an approval from a trusted session
 * is picked up by a quiet check every few seconds (or Continue). The flow's secret stays in memory only.
 */
export function DeviceApproval({
  waiting,
  onSignedIn,
  onCancel,
}: {
  waiting: DeviceAuthorisation;
  onSignedIn: (session: Session) => void;
  onCancel: () => void;
}) {
  const { t } = deviceApprovalCopy.useCopy();
  const { api, commit } = useSession();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [final, setFinal] = useState(false);
  // The request on the wire, if any. A press waits for a background check to land instead of being dropped.
  const inFlight = useRef<Promise<void> | null>(null);
  const done = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), []);

  function finish(answer: ApiResult<Session>, quiet: boolean): void {
    if (done.current) return;
    if (answer.ok) {
      if (!validAuthSession(answer.data)) {
        setRefusal({ ok: false, reason: 'uncertain', message: t('auth.device_authorisation_invalid') });
        return;
      }
      done.current = true;
      commit(answer.data);
      onSignedIn(answer.data);
      return;
    }
    if (quiet && answer.code === 'auth.device_authorisation_pending') return;
    if (FINAL.has(answer.code ?? '')) setFinal(true);
    setRefusal(answer);
  }

  async function call(procedure: 'auth.deviceApprove' | 'auth.deviceComplete', input: object, quiet = false) {
    if (done.current) return;
    if (inFlight.current) {
      if (quiet) return;
      await inFlight.current;
      if (done.current) return;
    }
    if (!quiet) {
      setBusy(true);
      setRefusal(null);
    }
    const request = (async () => {
      finish(await api.mutate('identity', procedure, input, sessionSchema), quiet);
    })();
    inFlight.current = request;
    try {
      await request;
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (!quiet) setBusy(false);
    }
  }

  useEffect(() => {
    if (final) return;
    const timer = setInterval(() => {
      void call('auth.deviceComplete', { flowId: waiting.flowId, secret: waiting.secret }, true);
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one poll per waiting request
  }, [waiting.flowId, final]);

  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('deviceCode');
    const code = input instanceof HTMLInputElement ? input.value.trim() : '';
    if (!code) {
      setRefusal({ ok: false, reason: 'error', message: t('codeMissing'), code: 'codeMissing' });
      return;
    }
    if (input instanceof HTMLInputElement) input.value = '';
    void call('auth.deviceApprove', { flowId: waiting.flowId, secret: waiting.secret, code });
  }

  const expires = new Date(waiting.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <section className="public-auth-code" aria-labelledby="device-approval-title">
      <h2 id="device-approval-title" ref={heading} tabIndex={-1}>
        {t('title')}
      </h2>
      <p>{t('intro')}</p>
      <p className="muted" role="status">
        {waiting.mailed ? t('mailed') : t('unmailed')}
      </p>
      {waiting.mailed && !final && (
        <form method="post" className="form-stack" onSubmit={approve}>
          <Field
            label={t('code')}
            name="deviceCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            required
            disabled={busy}
          />
          <Button type="submit" disabled={busy}>
            {busy ? t('checking') : t('approve')}
          </Button>
        </form>
      )}
      {!final && (
        <>
          <p className="muted">{t('fromOther')}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void call('auth.deviceComplete', { flowId: waiting.flowId, secret: waiting.secret })}
          >
            {t('continue')}
          </Button>
          <small className="muted">{t('expires', { time: expires })}</small>
        </>
      )}
      {refusal &&
        (refusal.code === 'codeMissing' || worded(refusal.code) ? (
          <div className="pub-notice" role="alert">
            <p>{refusal.code === 'codeMissing' ? t('codeMissing') : t(refusal.code as Worded)}</p>
            {refusal.code !== 'codeMissing' && <small lang="zxx">{refusal.code}</small>}
          </div>
        ) : (
          <Failure result={refusal} />
        ))}
      <Button variant="ghost" disabled={busy} onClick={onCancel}>
        {t('cancel')}
      </Button>
    </section>
  );
}
