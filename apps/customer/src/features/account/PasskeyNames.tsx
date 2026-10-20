import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { passkeyNamesCopy as copy } from './passkey-names-copy';
import { cleanName, passkeyList, renamed, renameStepUp } from './passkey-names';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

/**
 * Passkey names and types in Security (slice I-signin-sessions-09): label, kind, added and last-used time, the owner's
 * per-account limit (or "no limit set"), and rename. Rename confirms with a fresh 6-digit code or a passkey first. Every
 * attempt asks for its own confirmation, so a refused rename never reuses a spent one.
 */
export function PasskeyNames() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [editing, setEditing] = useState<string | null>(null);
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
    `passkey-names:${userId}`,
  );

  async function save(credentialId: string, method: 'code' | 'passkey', event: FormEvent<HTMLFormElement> | HTMLFormElement) {
    const element = event instanceof HTMLFormElement ? event : event.currentTarget;
    const data = new FormData(element);
    const label = cleanName(String(data.get('name') ?? ''));
    const code = String(data.get('code') ?? '').trim();
    if (!label) return setProblem('invalidName');
    if (method === 'code' && !/^\d{6}$/.test(code)) return setProblem('invalidCode');
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    try {
      const requestId = crypto.randomUUID();
      const how: StepUpMethod = method === 'code' ? { totpCode: code } : { passkey: true };
      const approval = await confirmWithStepUp(api, renameStepUp(credentialId, label, requestId), how);
      const answer = approval.ok
        ? await api.mutate(
            'identity',
            'renamePasskey',
            { credentialId, label, clientRequestId: requestId, stepUpApprovalId: approval.data.stepUpApprovalId },
            renamed,
          )
        : approval;
      if (!mounted.current) return;
      if (!answer.ok) return setFailure(answer);
      setEditing(null);
      setNote(t('saved'));
      reload();
    } finally {
      const field = element.elements.namedItem('code');
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const list = resource.data;
  if (!list) return null;
  const problemText = problem === 'invalidName' ? t('invalidName') : problem === 'invalidCode' ? t('invalidCode') : null;
  return (
    <section className="security__passkey-names security__card" aria-label={t('title')} lang={languageFor('title')}>
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p className="muted">{list.maxPerAccount === null ? t('noLimit') : t('limit', { count: list.maxPerAccount })}</p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {list.passkeys.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="security__rows">
          {list.passkeys.map((key) => (
            <li key={key.credentialId} className="security__row">
              <div>
                <strong>{key.label ?? t('unnamed')}</strong> <span className="security__ref">{t(key.kind)}</span>
                <span className="muted">
                  {' · '}
                  {t('added', { time: stamp(key.createdAt, timeZone) })}
                  {' · '}
                  {key.lastUsedAt ? t('lastUsed', { time: stamp(key.lastUsedAt, timeZone) }) : t('neverUsed')}
                </span>
              </div>
              {editing === key.credentialId ? (
                <form
                  ref={form}
                  className="stack"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(key.credentialId, 'code', event);
                  }}
                >
                  <Field label={t('nameField')} name="name" maxLength={64} defaultValue={key.label ?? ''} required disabled={busy} />
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
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => form.current && void save(key.credentialId, 'passkey', form.current)}
                    >
                      {t('savePasskey')}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => (setEditing(null), setProblem(null))}>
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  variant="secondary"
                  aria-label={t('renameLabel', { id: key.label ?? key.credentialId })}
                  onClick={() => (setNote(null), setFailure(null), setEditing(key.credentialId))}
                >
                  {t('rename')}
                </Button>
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
