import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';
import { trustedDevicesCopy as copy } from './trusted-devices-copy';
import {
  approveStepUp,
  deviceApprovedSchema,
  deviceRemovedSchema,
  removeStepUp,
  trustedDeviceCode,
  trustedDevicesSchema,
} from './trusted-devices-api';

type Pending = { kind: 'remove'; id: string; label: string } | { kind: 'approve'; id: string; label: string };
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Trusted devices in Security (I-signin-sessions-07). Lists the browsers this account trusts, says whether the owner
 * turned the new-device check on, and lets the owner approve a waiting sign-in or remove a device. Both confirm who you
 * are first (authenticator code or passkey).
 */
export function TrustedDevices({ onChanged }: { onChanged?: () => void }) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState<'invalidOtp' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'trustedDevices.list', undefined, trustedDevicesSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `trusted-devices:${userId}`,
  );

  function open(next: Pending | null) {
    setPending(next);
    setFailure(null);
    setProblem(null);
    setNote(null);
  }

  async function confirm(method: 'code' | 'passkey', element: HTMLFormElement) {
    if (!pending || busy) return;
    const otp = String(new FormData(element).get('otp') ?? '').trim();
    if (method === 'code' && !/^\d{6}$/.test(otp)) return setProblem('invalidOtp');
    setBusy(true);
    setFailure(null);
    setProblem(null);
    try {
      const how: StepUpMethod = method === 'code' ? { totpCode: otp } : { passkey: true };
      if (pending.kind === 'remove') {
        const requestId = crypto.randomUUID();
        const approval = await confirmWithStepUp(api, removeStepUp(pending.id, requestId), how);
        const answer = approval.ok
          ? await api.mutate(
              'identity',
              'trustedDevices.remove',
              { deviceId: pending.id, clientRequestId: requestId, stepUpApprovalId: approval.data.stepUpApprovalId },
              deviceRemovedSchema,
            )
          : approval;
        if (!mounted.current) return;
        if (!answer.ok) return setFailure(answer);
        setNote(answer.data.removed ? t('removed', { count: answer.data.sessionsEnded }) : t('removedNone'));
      } else {
        const approval = await confirmWithStepUp(api, approveStepUp(pending.id), how);
        const answer = approval.ok
          ? await api.mutate(
              'identity',
              'trustedDevices.approve',
              { flowId: pending.id, stepUpApprovalId: approval.data.stepUpApprovalId },
              deviceApprovedSchema,
            )
          : approval;
        if (!mounted.current) return;
        if (!answer.ok) return setFailure(answer);
        setNote(t('approved'));
      }
      setPending(null);
      reload();
      onChanged?.();
    } finally {
      const field = element.elements.namedItem('otp');
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') {
    return (
      <section data-testid="security__card" className="security__card" aria-label={t('title')} lang={languageFor('title')}>
        <h2>{t('title')}</h2>
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  }
  const state = resource.data;
  if (!state) return null;
  const worded = failure ? trustedDeviceCode(failure.code) : undefined;
  return (
    <section
      data-testid="security__card"
      className="security__trusted-devices security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p className="muted" role="status">
        {state.check === 'on' ? t('checkOn') : t('checkOff')}
      </p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure &&
        (worded ? (
          <p className="error-text" role="alert">
            {t(worded)}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      {state.waiting.length > 0 && (
        <div className="stack">
          <h3>{t('waitingTitle')}</h3>
          <p className="muted">{t('waitingBody')}</p>
          <ul data-testid="security__rows" className="security__rows">
            {state.waiting.map((row) => (
              <li key={row.flowId} data-testid="security__row" className="security__row">
                <span>{t('waitingRow', { device: row.label, time: stamp(row.createdAt, timeZone) })}</span>
                <Button
                  variant="secondary"
                  disabled={busy}
                  aria-label={t('approveLabel', { device: row.label })}
                  onClick={() => open({ kind: 'approve', id: row.flowId, label: row.label })}
                >
                  {t('approve')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.devices.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <ul data-testid="security__rows" className="security__rows">
          {state.devices.map((device) => (
            <li key={device.id} data-testid="security__row" className="security__row">
              <div>
                <strong>{device.label}</strong>{' '}
                {device.current && (
                  <span data-testid="security__ref" className="security__ref">
                    {t('thisDevice')}
                  </span>
                )}
                <span className="muted">
                  {' · '}
                  {t('firstSeen', { time: stamp(device.firstSeenAt, timeZone) })}
                  {' · '}
                  {t('lastSeen', { time: stamp(device.lastSeenAt, timeZone) })}
                  {' · '}
                  {device.trustedUntil ? t('until', { time: stamp(device.trustedUntil, timeZone) }) : t('untilRemoved')}
                </span>
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                aria-label={t('removeLabel', { device: device.label })}
                onClick={() => open({ kind: 'remove', id: device.id, label: device.label })}
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <form
          ref={form}
          className="stack"
          noValidate
          aria-label={pending.kind === 'remove' ? t('removeTitle') : t('approveTitle')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void confirm('code', event.currentTarget);
          }}
        >
          <h3>{pending.kind === 'remove' ? t('removeTitle') : t('approveTitle')}</h3>
          <p>
            <strong>{pending.label}</strong>
          </p>
          <p>{pending.kind === 'remove' ? t('removeBody') : t('approveBody')}</p>
          <Field
            label={t('otpField')}
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            data-security-sensitive="true"
          />
          {problem && (
            <p className="error-text" role="alert">
              {t(problem)}
            </p>
          )}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('withCode')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => form.current && void confirm('passkey', form.current)}>
              {t('withPasskey')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => open(null)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
