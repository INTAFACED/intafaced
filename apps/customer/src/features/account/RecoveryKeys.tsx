import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RECOVERY_LABEL_MAX, recoveryViewSchema, type RecoveryKeyChange, type RecoveryView } from '@intafaced/contracts/identity-recovery';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { recoveryKeysCopy as copy } from './recovery-keys-copy';
import { cleanHandle, resolveHandle } from '../../data/identity';
import { makeRecoveryKey, recoveryPlanTarget, recoveryStepUp, shortFingerprint, type MadeRecoveryKey } from './recovery-keys';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
/** One change on its way: sent once without a confirmation, so a refusal costs none, then again with one. */
type Change = {
  change: RecoveryKeyChange;
  procedure: 'recovery.keys.add' | 'recovery.keys.revoke' | 'recovery.plan.set';
  target: string;
  clientRequestId: string;
  body: Record<string, unknown>;
  made?: { key: MadeRecoveryKey; label: string };
  saved: string;
};

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Recovery keys, in Security (RC-identity-07, J-identity-05 #7): the account that receives the trading balances after a
 * confirmed death notice, how many keys must sign, and the keys the owner gives to people they trust. A key is made in
 * this browser and shown once; identity keeps only its fingerprint. Staff can never set, use or vote with a key. Every
 * change confirms with a 6-digit code or a passkey, asked only once nothing else refuses it.
 */
export function RecoveryKeys() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [waiting, setWaiting] = useState<Change | null>(null);
  const [shown, setShown] = useState<{ key: MadeRecoveryKey; label: string; unsure?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<RecoveryView | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'recovery.keys.list', {}, recoveryViewSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `recovery-keys:${userId}`,
  );
  useEffect(() => {
    if (resource.status === 'ready') setView(resource.data);
  }, [resource]);

  const clear = () => (setFailure(null), setProblem(null), setNote(null));
  const send = (change: Change, stepUpApprovalId?: string) =>
    api.mutate(
      'identity',
      change.procedure,
      { ...change.body, clientRequestId: change.clientRequestId, ...(stepUpApprovalId ? { stepUpApprovalId } : {}) },
      recoveryViewSchema,
    );

  function answered(change: Change, answer: ApiResult<RecoveryView>) {
    if (!mounted.current) return;
    if (answer.ok) {
      setWaiting(null);
      setView(answer.data);
      setNote(change.saved);
      if (change.made) setShown(change.made);
      return;
    }
    if (answer.code === 'identity.step_up_required') return setWaiting(change);
    setWaiting(null);
    setFailure(answer);
    // No typed refusal means the answer was lost, not that nothing happened: the key may be live, so its text stays.
    if (change.made && !answer.code) setShown({ ...change.made, unsure: true });
  }

  async function attempt(change: Change) {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      answered(change, await send(change));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function confirm(how: 'code' | 'passkey', element: HTMLFormElement) {
    const change = waiting;
    if (!change || busy) return;
    const field = element.elements.namedItem('code');
    const code = field instanceof HTMLInputElement ? field.value.trim() : '';
    if (how === 'code' && !/^\d{6}$/.test(code)) return setProblem(t('invalidCode'));
    clear();
    setBusy(true);
    try {
      const method: StepUpMethod = how === 'code' ? { totpCode: code } : { passkey: true };
      const approval = await confirmWithStepUp(api, recoveryStepUp(change.change, change.target, change.clientRequestId), method);
      answered(change, approval.ok ? await send(change, approval.data.stepUpApprovalId) : approval);
    } finally {
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  async function make(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const label = String(new FormData(element).get('label') ?? '').trim();
    // One key on screen at a time: its holder's text must not be replaced before it is saved.
    if (shown) return;
    clear();
    if (!label || label.length > RECOVERY_LABEL_MAX) return setProblem(t('labelInvalid'));
    let key: MadeRecoveryKey;
    try {
      key = await makeRecoveryKey();
    } catch {
      return setProblem(t('noCrypto'));
    }
    element.reset();
    await attempt({
      change: 'add',
      procedure: 'recovery.keys.add',
      target: key.fingerprint,
      clientRequestId: `recovery:add:${key.fingerprint}`,
      body: { kind: 'key', label, publicKey: key.publicKey },
      made: { key, label },
      saved: t('saved'),
    });
  }

  async function savePlan(event: FormEvent<HTMLFormElement>, live: number) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const handle = cleanHandle(String(data.get('heir') ?? ''));
    const threshold = Number(data.get('threshold'));
    clear();
    if (!handle) return setProblem(t('heirInvalid'));
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > live) return setProblem(t('thresholdInvalid'));
    if (busy) return;
    // The handle is checked before asking for a confirmation, with the same exact lookup a payment uses.
    setBusy(true);
    const hit = await resolveHandle(api, handle);
    if (!mounted.current) return;
    setBusy(false);
    if (hit.kind === 'notFound') return setProblem(t('heirUnknown'));
    if (hit.kind === 'rateLimited') return setProblem(t('heirRateLimited'));
    if (hit.kind === 'found' && hit.self) return setProblem(t('heirSelf'));
    // An older server with no lookup, or a failed one, leaves the check to identity, after the confirmation.
    await attempt({
      change: 'plan',
      procedure: 'recovery.plan.set',
      target: recoveryPlanTarget(handle, threshold),
      clientRequestId: `recovery:${recoveryPlanTarget(handle, threshold)}`,
      body: { heirHandle: handle, threshold },
      saved: t('saved'),
    });
  }

  if (resource.status === 'loading' && !view) return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const current = view ?? (resource.status === 'ready' ? resource.data : null);
  if (!current) return null;
  const live = current.keys.filter((key) => key.revokedAt === null);
  const missing = current.missing.map((part) =>
    part === 'heir' ? t('missingHeir') : part === 'threshold' ? t('missingThreshold') : t('missingKeys'),
  );

  return (
    <section
      data-testid="security__recovery-keys"
      className="security__recovery-keys security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p>
        <strong>{t('promise')}</strong>
      </p>
      {current.keys.length === 0 ? (
        <p className="muted" role="status">
          {t('noKeys')}
        </p>
      ) : current.ready && current.heir?.active && current.threshold ? (
        <p className="notice" role="status">
          {t('ready', { threshold: current.threshold, count: current.activeKeys, heir: current.heir.handle })}
        </p>
      ) : (
        <p className="muted" role="status">
          {t('notReady', { missing: missing.join(', ') })}
        </p>
      )}
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {problem && (
        <p className="error-text" role="alert">
          {problem}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {shown && (
        <section className="stack security__confirm" aria-label={t('madeTitle', { label: shown.label })}>
          <h3>{t('madeTitle', { label: shown.label })}</h3>
          <p>{t('madeBody')}</p>
          {shown.unsure && (
            <p className="error-text" role="alert">
              {t('madeUnsure')}
            </p>
          )}
          <label className="field">
            <span>{t('madeField', { label: shown.label })}</span>
            <textarea readOnly rows={3} value={shown.key.text} lang="zxx" data-security-sensitive="true" />
          </label>
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => saveFile(`intafaced-recovery-key-${shown.key.fingerprint.slice(0, 8)}.txt`, shown.key.text)}
            >
              {t('download')}
            </Button>
            <Button onClick={() => setShown(null)}>{t('done')}</Button>
          </div>
        </section>
      )}
      {waiting && (
        <form
          ref={form}
          className="stack security__confirm"
          aria-label={t('confirmTitle')}
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void confirm('code', event.currentTarget);
          }}
        >
          <h3>{t('confirmTitle')}</h3>
          <p>{waiting.change === 'add' ? t('confirmAdd') : waiting.change === 'revoke' ? t('confirmRevoke') : t('confirmPlan')}</p>
          <Field
            label={t('codeField')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            data-security-sensitive="true"
          />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('save')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => form.current && void confirm('passkey', form.current)}>
              {t('savePasskey')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => (setWaiting(null), setProblem(null))}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}

      <h3>{t('heirTitle')}</h3>
      <p className="muted">
        {current.heir && !current.heir.active
          ? t('heirGone', { heir: current.heir.handle })
          : current.heir && current.threshold
            ? t('heirNow', { heir: current.heir.handle, threshold: current.threshold })
            : t('heirNone')}
      </p>
      <form className="stack" aria-label={t('heirTitle')} noValidate onSubmit={(event) => void savePlan(event, live.length)}>
        <Field label={t('heirField')} name="heir" autoComplete="off" disabled={busy} defaultValue={current.heir?.handle ?? ''} />
        <Field
          label={t('thresholdField')}
          name="threshold"
          type="number"
          inputMode="numeric"
          min={1}
          max={Math.max(1, live.length)}
          disabled={busy}
          defaultValue={current.threshold ?? ''}
          hint={t('thresholdHint', { count: live.length })}
        />
        <div className="row">
          <Button type="submit" variant="secondary" disabled={busy}>
            {t('savePlan')}
          </Button>
        </div>
      </form>

      <h3>{t('keysTitle')}</h3>
      {current.keys.length > 0 && (
        <ul data-testid="security__rows" className="security__rows">
          {current.keys.map((key) => (
            <li key={key.id} data-testid="security__row" className="security__row" aria-label={key.label}>
              <div>
                <strong>{key.label}</strong>{' '}
                <span className="muted">
                  {key.revokedAt
                    ? t('keyRevoked', { time: stamp(key.revokedAt, timeZone) })
                    : t('keyAdded', { time: stamp(key.createdAt, timeZone) })}
                </span>{' '}
                <span className="muted security__fingerprint" lang="zxx">
                  {t('fingerprint', { fingerprint: shortFingerprint(key.fingerprint) })}
                </span>
              </div>
              {!key.revokedAt && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  aria-label={t('revokeLabel', { label: key.label })}
                  onClick={() =>
                    void attempt({
                      change: 'revoke',
                      procedure: 'recovery.keys.revoke',
                      target: key.id,
                      clientRequestId: `recovery:revoke:${key.id}`,
                      body: { keyId: key.id },
                      saved: t('revoked'),
                    })
                  }
                >
                  {t('revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="stack" aria-label={t('makeTitle')} noValidate onSubmit={(event) => void make(event)}>
        <h3>{t('makeTitle')}</h3>
        <p className="muted">{t('makeBody')}</p>
        <Field label={t('labelField')} name="label" maxLength={RECOVERY_LABEL_MAX} autoComplete="off" disabled={busy || shown !== null} />
        <div className="row">
          <Button type="submit" disabled={busy || shown !== null}>
            {t('make')}
          </Button>
        </div>
      </form>
      <div className="actions">
        <Button variant="secondary" onClick={() => (setView(null), reload())}>
          {t('refresh')}
        </Button>
      </div>
    </section>
  );
}
