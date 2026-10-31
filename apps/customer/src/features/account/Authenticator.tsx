import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { authenticatorCopy as copy } from './authenticator-copy';
import { CodesHelp } from './CodesHelp';
import {
  disabledAnswer,
  isProof,
  isSixDigits,
  replacedAnswer,
  replaceStarted,
  stepUpBegun,
  stepUpBeginInput,
  stepUpDone,
  stepUpProof,
  totpStatus,
  type StepUpScope,
} from './authenticator-api';

type Mode =
  | { kind: 'idle' }
  | { kind: 'rename' }
  | { kind: 'confirm'; action: 'disable' | 'replace' }
  | { kind: 'disable'; requestId: string; approvalId: string }
  | { kind: 'replace'; requestId: string; approvalId: string; secret: string; uri: string }
  | { kind: 'codes'; codes: string[] };

/**
 * The authenticator-app card in Security (slice I-signin-sessions-11): on, name, set-up date, rename, replace and turn off.
 * Turning off and replacing first confirm with a fresh code or, for someone who lost the phone, a recovery code (the
 * step-up), then prove the current authenticator again with the next code or a recovery code, because a code works once.
 * A replace shows the new recovery codes once and ends every other session. Codes are read when the form is sent and
 * cleared after. Shows nothing while no authenticator is set up; setting one up stays in the setup card. `onChanged`
 * hears every change to the factor; after a replace it also says how many other sessions ended.
 */
export function Authenticator({ onChanged }: { onChanged?: (change?: { sessionsEnded: number }) => void }) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [problem, setProblem] = useState<'invalidCode' | 'invalidProof' | 'tooFewCodes' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [codesKept, setCodesKept] = useState(false);
  // The help panel belongs to the idle card: leaving idle by any route closes it, so it never reopens on its own.
  useEffect(() => {
    if (mode.kind !== 'idle') setHelp(false);
  }, [mode.kind]);
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
        ? api.query('identity', 'totpManage.status', undefined, totpStatus, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `authenticator:${userId}`,
  );

  function wipe() {
    form.current?.querySelectorAll('input').forEach((input) => {
      if (input.dataset.securitySensitive) input.value = '';
    });
  }
  const read = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
  function fail<T>(result: ApiResult<T>): result is Extract<ApiResult<T>, { ok: false }> {
    if (result.ok) return false;
    if (mounted.current) setFailure(result);
    return true;
  }
  function done(message: string) {
    setMode({ kind: 'idle' });
    setNote(message);
    reload();
    onChanged?.();
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    try {
      await work();
    } finally {
      wipe();
      if (mounted.current) setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>, action: 'disable' | 'replace') {
    event.preventDefault();
    // Someone who lost the phone confirms with a recovery code, which is spent. The next step takes one more, so with
    // fewer than two left the locked-out reset at sign-in is the way back, said before a code is spent.
    const proof = stepUpProof(read(new FormData(event.currentTarget), 'confirm-code'));
    if (!proof) return setProblem('invalidProof');
    const left = resource.status === 'ready' ? (resource.data?.recoveryCodesLeft ?? 0) : 0;
    if ('recoveryCode' in proof && left < 2) return setProblem('tooFewCodes');
    await run(async () => {
      const requestId = crypto.randomUUID();
      const scope: StepUpScope = action === 'disable' ? 'identity.step_up.totp_disable' : 'identity.step_up.totp_replace';
      const begun = await api.mutate('identity', 'stepUp.begin', stepUpBeginInput(scope, requestId), stepUpBegun);
      if (fail(begun)) return;
      const approved = await api.mutate('identity', 'stepUp.complete', { challengeId: begun.data.challengeId, ...proof }, stepUpDone, {
        keepSessionFor: ['auth.mfa_invalid'],
      });
      if (fail(approved)) return;
      if (action === 'disable') {
        if (mounted.current) setMode({ kind: 'disable', requestId, approvalId: approved.data.stepUpApprovalId });
        return;
      }
      // The confirmation just given lets a session that signed in without its second factor start the replace too.
      const started = await api.mutate(
        'identity',
        'totpManage.replaceStart',
        { clientRequestId: requestId, stepUpApprovalId: approved.data.stepUpApprovalId },
        replaceStarted,
      );
      if (fail(started)) return;
      if (mounted.current) setMode({ kind: 'replace', requestId, approvalId: approved.data.stepUpApprovalId, ...started.data });
    });
  }

  async function disable(event: FormEvent<HTMLFormElement>, step: { requestId: string; approvalId: string }) {
    event.preventDefault();
    const proof = read(new FormData(event.currentTarget), 'next-code');
    if (!isProof(proof)) return setProblem('invalidProof');
    await run(async () => {
      const answer = await api.mutate(
        'identity',
        'totpManage.disable',
        { code: proof, clientRequestId: step.requestId, stepUpApprovalId: step.approvalId },
        disabledAnswer,
        { keepSessionFor: ['auth.mfa_invalid'] },
      );
      // The service spends the approval before it checks the code, so any refusal needs a fresh confirmation.
      if (fail(answer)) return mounted.current ? setMode({ kind: 'confirm', action: 'disable' }) : undefined;
      if (mounted.current) done(answer.data.recoveryCodeSpent ? `${t('disabled')} ${t('spent')}` : t('disabled'));
    });
  }

  async function replace(event: FormEvent<HTMLFormElement>, step: { requestId: string; approvalId: string; secret: string }) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const newCode = read(data, 'new-code');
    const proof = read(data, 'next-code');
    if (!isSixDigits(newCode)) return setProblem('invalidCode');
    if (!isProof(proof)) return setProblem('invalidProof');
    await run(async () => {
      const answer = await api.mutate(
        'identity',
        'totpManage.replaceConfirm',
        { secret: step.secret, newCode, currentCode: proof, clientRequestId: step.requestId, stepUpApprovalId: step.approvalId },
        replacedAnswer,
        { keepSessionFor: ['auth.mfa_invalid'] },
      );
      // An answer lost on the way may hide a swap that happened: the new codes cannot be shown again, so say so and read
      // the card afresh instead of asking to confirm as if nothing changed.
      if (!answer.ok && answer.reason === 'uncertain') {
        if (mounted.current) done(t('replaceUnknown'));
        return;
      }
      // Same as turning off: a spent approval cannot be reused, so start the confirmation again (a new setup key follows).
      if (fail(answer)) return mounted.current ? setMode({ kind: 'confirm', action: 'replace' }) : undefined;
      if (!mounted.current) return;
      const { recoveryCodeSpent, recoveryCodes, sessionsEnded } = answer.data;
      // The new codes stay on this page until "I saved them"; the card's count is read again only then, so a failed
      // read can never hide them. The note says what else changed.
      setCodesKept(false);
      setMode({ kind: 'codes', codes: recoveryCodes });
      setNote(
        [
          t('replaced'),
          recoveryCodeSpent ? t('spent') : null,
          sessionsEnded > 0 ? t('signedOut', { count: sessionsEnded }) : t('noneSignedOut'),
        ]
          .filter(Boolean)
          .join(' '),
      );
      onChanged?.({ sessionsEnded });
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = read(new FormData(event.currentTarget), 'label');
    await run(async () => {
      const answer = await api.mutate('identity', 'totpManage.rename', { label }, totpStatus);
      if (fail(answer)) return;
      if (mounted.current) done(t('renamed'));
    });
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const status = resource.data;
  if (!status || !status.enabled) return null;
  const problemText = problem ? t(problem) : null;
  const when = status.enrolledAt ? stamp(status.enrolledAt, timeZone) : null;
  return (
    <section
      data-testid="security__authenticator"
      className="security__authenticator security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>
        {t('on')} · {status.label ?? t('unnamed')}
        {when ? ` · ${t('since')} ${when}` : ''} · {t('codesLeft', { count: status.recoveryCodesLeft })}
      </p>
      {note && (
        <p data-testid="notice" className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {mode.kind === 'idle' && (
        <div className="row">
          <Button variant="secondary" onClick={() => setMode({ kind: 'rename' })}>
            {t('rename')}
          </Button>
          <Button variant="secondary" onClick={() => (setNote(null), setMode({ kind: 'confirm', action: 'replace' }))}>
            {t('replace')}
          </Button>
          <Button variant="danger" onClick={() => (setNote(null), setMode({ kind: 'confirm', action: 'disable' }))}>
            {t('disable')}
          </Button>
          {!help && (
            <Button variant="ghost" onClick={() => setHelp(true)}>
              {t('codesHelp')}
            </Button>
          )}
        </div>
      )}
      {mode.kind === 'idle' && help && (
        <CodesHelp
          onReplace={() => (setHelp(false), setNote(null), setMode({ kind: 'confirm', action: 'replace' }))}
          onClose={() => setHelp(false)}
        />
      )}
      {mode.kind === 'rename' && (
        <form ref={form} className="stack" onSubmit={(e) => void rename(e)} noValidate>
          <Field label={t('renameField')} name="label" maxLength={64} defaultValue={status.label ?? ''} required disabled={busy} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('renameSave')}
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: 'idle' })} disabled={busy}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {mode.kind === 'confirm' && (
        <form ref={form} className="stack" onSubmit={(e) => void confirm(e, mode.action)} noValidate>
          <h3>{t('confirmTitle')}</h3>
          <p>{t('confirmBody')}</p>
          <Field
            label={t('confirmField')}
            name="confirm-code"
            autoComplete="one-time-code"
            maxLength={64}
            required
            disabled={busy}
            data-security-sensitive="true"
          />
          {problemText && (
            <p className="error-text" role="alert">
              {problemText}
            </p>
          )}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('confirmSubmit')}
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: 'idle' })} disabled={busy}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {mode.kind === 'disable' && (
        <form ref={form} className="stack" onSubmit={(e) => void disable(e, mode)} noValidate>
          <p>{t('nextBody')}</p>
          <Field
            label={t('nextField')}
            name="next-code"
            autoComplete="one-time-code"
            maxLength={64}
            required
            disabled={busy}
            data-security-sensitive="true"
          />
          {problemText && (
            <p className="error-text" role="alert">
              {problemText}
            </p>
          )}
          <div className="row">
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? t('working') : t('disableSubmit')}
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: 'idle' })} disabled={busy}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {mode.kind === 'codes' && (
        // Shown once, after the swap. "I saved them" drops the codes from this page; nothing is written to storage.
        <div data-testid="security__recovery" className="security__recovery stack" data-security-sensitive="true">
          <h3>{t('newCodesTitle')}</h3>
          <p>{t('newCodesOnce')}</p>
          <ul data-testid="recovery-codes" className="recovery-codes">
            {mode.codes.map((value) => (
              <li key={value} lang="zxx">
                {value}
              </li>
            ))}
          </ul>
          <label className="security__check">
            <input type="checkbox" checked={codesKept} onChange={(event) => setCodesKept(event.target.checked)} />
            {t('newCodesCheck')}
          </label>
          <Button disabled={!codesKept} onClick={() => (setCodesKept(false), setMode({ kind: 'idle' }), reload())}>
            {t('newCodesSaved')}
          </Button>
        </div>
      )}
      {mode.kind === 'replace' && (
        <form ref={form} className="stack" onSubmit={(e) => void replace(e, mode)} noValidate>
          <p>{t('replaceBody')}</p>
          <p>
            {t('replaceKey')}: <code data-security-sensitive="true">{mode.secret}</code>
          </p>
          <Field
            label={t('replaceNew')}
            name="new-code"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            required
            disabled={busy}
            data-security-sensitive="true"
          />
          <p>{t('nextBody')}</p>
          <Field
            label={t('nextField')}
            name="next-code"
            autoComplete="off"
            maxLength={64}
            required
            disabled={busy}
            data-security-sensitive="true"
          />
          {problemText && (
            <p className="error-text" role="alert">
              {problemText}
            </p>
          )}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('replaceSubmit')}
            </Button>
            <Button variant="ghost" onClick={() => setMode({ kind: 'idle' })} disabled={busy}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
