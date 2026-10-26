import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { passkeyNamesCopy as copy } from './passkey-names-copy';
import {
  cleanName,
  encodePurposes,
  passkeyList,
  PASSKEY_PURPOSES,
  purposesStepUp,
  renamed,
  renameStepUp,
  secondStepStepUp,
  type PasskeyPurpose,
} from './passkey-names';
import { confirmWithStepUp, type StepUpBegin, type StepUpMethod } from './security-step-up';

type Editing = { kind: 'rename' | 'purposes'; credentialId: string } | { kind: 'secondStep' } | null;

/**
 * Passkey names and types in Security (slice I-signin-sessions-09): label, kind, added and last-used time, the owner's
 * per-account limit (or "no limit set"), and rename. Each passkey can be kept for some actions only, and sign-in can
 * ask for a passkey after the password (I-signin-sessions-10). Every change confirms with a fresh 6-digit code or a
 * passkey first, and every attempt asks for its own confirmation, so a refused change never reuses a spent one.
 * `revision` goes up when Security adds or removes a passkey, and these names load again.
 */
export function PasskeyNames({ revision = 0 }: { revision?: number } = {}) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [problem, setProblem] = useState<'invalidName' | 'invalidCode' | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
        ? api.query('identity', 'listPasskeys', { limit: 200 }, passkeyList, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    // A passkey added or removed in Security's own list reloads these names.
    `passkey-names:${userId}:${revision}`,
  );

  /** Confirm the change named by `request`, then send it with the approval. */
  async function confirmed(
    element: HTMLFormElement,
    method: 'code' | 'passkey',
    request: (requestId: string) => StepUpBegin | null,
    send: (requestId: string, stepUpApprovalId: string) => Promise<ApiResult<unknown>>,
    saved: string,
  ) {
    const data = new FormData(element);
    const code = String(data.get('code') ?? '').trim();
    const requestId = crypto.randomUUID();
    const begin = request(requestId);
    if (!begin) return setProblem('invalidName');
    if (method === 'code' && !/^\d{6}$/.test(code)) return setProblem('invalidCode');
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    try {
      const how: StepUpMethod = method === 'code' ? { totpCode: code } : { passkey: true };
      const approval = await confirmWithStepUp(api, begin, how);
      const answer = approval.ok ? await send(requestId, approval.data.stepUpApprovalId) : approval;
      if (!mounted.current) return;
      if (!answer.ok) return setFailure(answer);
      setEditing(null);
      setNote(saved);
      reload();
    } finally {
      const field = element.elements.namedItem('code');
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  function rename(credentialId: string, method: 'code' | 'passkey', element: HTMLFormElement) {
    const label = cleanName(String(new FormData(element).get('name') ?? ''));
    return confirmed(
      element,
      method,
      (requestId) => (label ? renameStepUp(credentialId, label, requestId) : null),
      (requestId, stepUpApprovalId) =>
        api.mutate('identity', 'renamePasskey', { credentialId, label, clientRequestId: requestId, stepUpApprovalId }, renamed),
      t('saved'),
    );
  }

  function choose(credentialId: string, method: 'code' | 'passkey', element: HTMLFormElement) {
    const data = new FormData(element);
    const purposes = encodePurposes(PASSKEY_PURPOSES.filter((purpose) => data.get(`purpose-${purpose}`) === 'on'));
    return confirmed(
      element,
      method,
      (requestId) => purposesStepUp(credentialId, purposes, requestId),
      (requestId, stepUpApprovalId) =>
        api.mutate('identity', 'setPasskeyPurposes', { credentialId, purposes, clientRequestId: requestId, stepUpApprovalId }, renamed),
      t('purposesSaved'),
    );
  }

  function secondStep(on: boolean, method: 'code' | 'passkey', element: HTMLFormElement) {
    return confirmed(
      element,
      method,
      (requestId) => secondStepStepUp(on, requestId),
      (requestId, stepUpApprovalId) =>
        api.mutate(
          'identity',
          'setPasskeySecondStep',
          { on, clientRequestId: requestId, stepUpApprovalId },
          z.object({ secondStep: z.boolean() }),
        ),
      t('secondStepSaved'),
    );
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const list = resource.data;
  if (!list) return null;
  const problemText = problem === 'invalidName' ? t('invalidName') : problem === 'invalidCode' ? t('invalidCode') : null;
  const open = (next: Editing) => (setNote(null), setFailure(null), setProblem(null), setEditing(next));

  /** The code field and the two ways to confirm, shared by every change here. */
  function confirmForm(onConfirm: (method: 'code' | 'passkey', element: HTMLFormElement) => void, fields: ReactNode) {
    return (
      <form
        ref={form}
        className="stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onConfirm('code', event.currentTarget);
        }}
      >
        {fields}
        <Field
          label={t('codeField')}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
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
            {busy ? t('working') : t('save')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => form.current && onConfirm('passkey', form.current)}>
            {t('savePasskey')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => (setEditing(null), setProblem(null))}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    );
  }

  const usedFor = (purposes: readonly PasskeyPurpose[]) =>
    t('usedFor', { list: purposes.length === 0 ? t('everyAction') : purposes.map((purpose) => t(purpose)).join(', ') });

  return (
    <section
      data-testid="security__passkey-names"
      className="security__passkey-names security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p className="muted">{list.maxPerAccount === null ? t('noLimit') : t('limit', { count: list.maxPerAccount })}</p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      <div className="security__second-step" role="group" aria-label={t('secondStepTitle')}>
        <h3>{t('secondStepTitle')}</h3>
        <p>{list.secondStep ? t('secondStepOn') : list.passkeys.length === 0 ? t('secondStepNeedsPasskey') : t('secondStepOff')}</p>
        {editing?.kind === 'secondStep' ? (
          confirmForm((method, element) => void secondStep(!list.secondStep, method, element), null)
        ) : list.secondStep || list.passkeys.length > 0 ? (
          <Button variant="secondary" onClick={() => open({ kind: 'secondStep' })}>
            {list.secondStep ? t('turnOff') : t('turnOn')}
          </Button>
        ) : null}
      </div>
      {list.passkeys.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul data-testid="security__rows" className="security__rows">
          {list.passkeys.map((key) => (
            <li
              key={key.credentialId}
              data-testid="security__row"
              className={
                editing && 'credentialId' in editing && editing.credentialId === key.credentialId
                  ? 'security__row security__row--editing'
                  : 'security__row'
              }
            >
              <div>
                <strong>{key.label ?? t('unnamed')}</strong>{' '}
                <span data-testid="security__ref" className="security__ref">
                  {t(key.kind)}
                </span>
                <span className="muted">
                  {' · '}
                  {t('added', { time: stamp(key.createdAt, timeZone) })}
                  {' · '}
                  {key.lastUsedAt ? t('lastUsed', { time: stamp(key.lastUsedAt, timeZone) }) : t('neverUsed')}
                </span>
                <span className="security__purposes">{usedFor(key.purposes)}</span>
              </div>
              {editing?.kind === 'rename' && editing.credentialId === key.credentialId ? (
                confirmForm(
                  (method, element) => void rename(key.credentialId, method, element),
                  <Field label={t('nameField')} name="name" maxLength={64} defaultValue={key.label ?? ''} required disabled={busy} />,
                )
              ) : editing?.kind === 'purposes' && editing.credentialId === key.credentialId ? (
                confirmForm(
                  (method, element) => void choose(key.credentialId, method, element),
                  <fieldset className="stack">
                    <legend>{t('purposesLegend')}</legend>
                    <p className="muted">{t('purposesHint')}</p>
                    {PASSKEY_PURPOSES.map((purpose) => (
                      <label key={purpose} className="security__check">
                        <input
                          type="checkbox"
                          name={`purpose-${purpose}`}
                          defaultChecked={key.purposes.includes(purpose)}
                          disabled={busy}
                        />
                        {t(purpose)}
                      </label>
                    ))}
                  </fieldset>,
                )
              ) : (
                <>
                  <Button
                    variant="secondary"
                    aria-label={t('renameLabel', { id: key.label ?? key.credentialId })}
                    onClick={() => open({ kind: 'rename', credentialId: key.credentialId })}
                  >
                    {t('rename')}
                  </Button>
                  <Button
                    variant="secondary"
                    aria-label={t('chooseLabel', { id: key.label ?? key.credentialId })}
                    onClick={() => open({ kind: 'purposes', credentialId: key.credentialId })}
                  >
                    {t('choose')}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <Button variant="secondary" onClick={reload}>
          {t('refresh')}
        </Button>
      </div>
    </section>
  );
}
