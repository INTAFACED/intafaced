import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { antiPhishingCopy as copy } from './anti-phishing-copy';
import {
  antiPhishingCodeSchema,
  antiPhishingRefusal,
  antiPhishingSetResultSchema,
  antiPhishingStepUp,
  cleanAntiPhishingCode,
  type AntiPhishingRefusal,
} from './anti-phishing';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

type Mode = 'view' | 'set' | 'remove';

/**
 * The anti-phishing code card in Security (slice I-signin-sessions-25): the current code, a preview of how our security
 * emails show it, and set, change or remove. Every save confirms with a fresh 6-digit code or a passkey first, bound to
 * the exact code; the code is read only from the form and never kept in storage.
 */
export function AntiPhishing() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [problem, setProblem] = useState<'invalidCode' | 'invalidOtp' | AntiPhishingRefusal | null>(null);
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
        ? api.query('identity', 'profile.antiPhishing.get', undefined, antiPhishingCodeSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `anti-phishing:${userId}`,
  );

  async function save(method: 'code' | 'passkey', element: HTMLFormElement) {
    const data = new FormData(element);
    const code = mode === 'remove' ? '' : cleanAntiPhishingCode(String(data.get('anti-phishing-code') ?? ''));
    const otp = String(data.get('otp') ?? '').trim();
    if (code === null) return setProblem('invalidCode');
    if (method === 'code' && !/^\d{6}$/.test(otp)) return setProblem('invalidOtp');
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setProblem(null);
    setNote(null);
    try {
      const requestId = crypto.randomUUID();
      const how: StepUpMethod = method === 'code' ? { totpCode: otp } : { passkey: true };
      const approval = await confirmWithStepUp(api, antiPhishingStepUp(code, requestId), how);
      const answer = approval.ok
        ? await api.mutate(
            'identity',
            'profile.antiPhishing.set',
            { code, clientRequestId: requestId, stepUpApprovalId: approval.data.stepUpApprovalId },
            antiPhishingSetResultSchema,
          )
        : approval;
      if (!mounted.current) return;
      if (!answer.ok) {
        const refusal = antiPhishingRefusal(answer);
        return refusal ? setProblem(refusal) : setFailure(answer);
      }
      setMode('view');
      setNote(t(code === '' ? (answer.data.changed ? 'removed' : 'nothingToRemove') : answer.data.changed ? 'saved' : 'unchanged'));
      reload();
    } finally {
      for (const name of ['otp', 'anti-phishing-code']) {
        const field = element.elements.namedItem(name);
        if (field instanceof HTMLInputElement) field.value = '';
      }
      if (mounted.current) setBusy(false);
    }
  }

  function open(next: Mode) {
    setNote(null);
    setFailure(null);
    setProblem(null);
    setMode(next);
  }

  if (resource.status === 'loading') return <Loading />;
  // A code this service cannot read is shown as such, with set and remove still offered to replace it.
  const unreadable = resource.status === 'failed' && antiPhishingRefusal(resource.failure) === 'refusedUnreadable';
  if (resource.status === 'failed' && !unreadable) {
    const refusal = antiPhishingRefusal(resource.failure);
    return (
      <section
        data-testid="security__anti-phishing"
        className="security__anti-phishing security__card"
        aria-label={t('title')}
        lang={languageFor('title')}
      >
        <h2>{t('title')}</h2>
        <p>{t('body')}</p>
        {refusal ? (
          <p className="error-text" role="status">
            {t(refusal)}
          </p>
        ) : (
          <Failure result={resource.failure} retry={reload} />
        )}
      </section>
    );
  }
  const view = resource.status === 'ready' ? resource.data : { code: null, updatedAt: null };
  if (!view) return null;
  const problemText = problem ? t(problem) : null;
  return (
    <section
      data-testid="security__anti-phishing"
      className="security__anti-phishing security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      <p className="muted">{t('carried')}</p>
      {unreadable ? (
        <p className="error-text">{t('refusedUnreadable')}</p>
      ) : view.code ? (
        <p>
          <strong>{t('current', { code: view.code })}</strong>
          {view.updatedAt && <span className="muted"> · {t('setAt', { time: stamp(view.updatedAt, timeZone) })}</span>}
        </p>
      ) : (
        <p className="muted">{t('none')}</p>
      )}
      <figure data-testid="security__mail-preview" className="security__mail-preview" aria-label={t('previewTitle')}>
        <figcaption>
          {t('previewTitle')}{' '}
          <span data-testid="security__ref" className="security__ref">
            {t('previewSample')}
          </span>
        </figcaption>
        <p>{view.code ? t('previewLine', { code: view.code }) : t('previewNone')}</p>
      </figure>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {failure && <Failure result={failure} />}
      {mode === 'view' ? (
        <div className="row">
          <Button variant="secondary" onClick={() => open('set')}>
            {view.code ? t('change') : t('setCode')}
          </Button>
          {(view.code || unreadable) && (
            <Button variant="ghost" onClick={() => open('remove')}>
              {t('remove')}
            </Button>
          )}
        </div>
      ) : (
        <form
          ref={form}
          className="stack"
          noValidate
          aria-label={mode === 'remove' ? t('removeTitle') : t('title')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void save('code', event.currentTarget);
          }}
        >
          {mode === 'remove' ? (
            <p>{t('removeBody')}</p>
          ) : (
            <Field
              label={t('codeField')}
              name="anti-phishing-code"
              hint={t('codeHint')}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              required
              disabled={busy}
              data-security-sensitive="true"
            />
          )}
          <Field
            label={t('otpField')}
            name="otp"
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
              {busy ? t('working') : mode === 'remove' ? t('removeCode') : t('save')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => form.current && void save('passkey', form.current)}>
              {mode === 'remove' ? t('removePasskey') : t('savePasskey')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => open('view')}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
