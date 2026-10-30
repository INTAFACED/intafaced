import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import { appealSchema, APPEAL_TEXT_MAX, type Appeal } from '@intafaced/contracts/identity-appeals';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button } from '../../shared/ui';
import { appealSignedOutCopy } from './appeal-signed-out-copy';
import './public-pages.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const APPEAL_REFUSALS = new Set([
  'identity.appeal_open',
  'identity.appeal_window_unset',
  'identity.appeal_window_closed',
  'identity.appeal_no_restriction',
  'identity.appeal_setter_unknown',
  'identity.appeal_sign_in',
  'identity.appeal_not_allowed',
  'identity.appeal_request_conflict',
]);

/**
 * /appeal : a staff-frozen person's appeal (I-account-lifecycle-12, J-identity-11 #5), on the flow template. They cannot
 * sign in, so the form takes the sign-in name and password, which identity checks exactly as sign-in does (a wrong one is
 * the sign-in refusal), and files an appeal of the freeze. Nothing here signs in or lifts anything; staff decide and the
 * person is mailed the decision. The password is never kept by the page after it is sent. A refusal is the template's.
 */
export function AppealSignedOut() {
  const { t } = appealSignedOutCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [done, setDone] = useState<Appeal | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  // One key per appeal being written: a retry after a lost answer is the same appeal.
  const requestKey = useRef<string>(crypto.randomUUID());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const identifier = String(form.get('appeal-identifier') ?? '').trim();
    const password = String(form.get('appeal-password') ?? '');
    const text = String(form.get('appeal-text') ?? '').trim();
    if (!identifier || !password || !text) return setMissing(true);
    setMissing(false);
    setBusy(true);
    setFailed(null);
    const passwordField = event.currentTarget.elements.namedItem('appeal-password');
    if (passwordField instanceof HTMLInputElement) passwordField.value = '';
    const answer = await api.mutate(
      'identity',
      'accountAppeal.submitSignedOut',
      { identifier, password, text, clientRequestId: requestKey.current },
      appealSchema,
    );
    if (!mounted.current) return;
    setBusy(false);
    if (answer.ok) setDone(answer.data);
    else setFailed(answer);
  }

  const state: RoomState = useMemo(() => {
    if (!failed) return { kind: 'ready' };
    const code = failed.code;
    const refusal: Refusal =
      code && APPEAL_REFUSALS.has(code)
        ? { variant: 'refused', title: t('refusedOther'), body: t(`refused_${code}` as never), reference: code }
        : {
            variant: failed.reason === 'unreachable' || failed.reason === 'uncertain' ? 'unreachable' : 'refused',
            title: t('refusedOther'),
            body: failed.message,
            ...(code ? { reference: code } : {}),
          };
    return { kind: 'ready', partial: { missing: refusal } };
  }, [failed, t]);

  return (
    <FlowTemplate
      title={done ? t('sentTitle') : t('title')}
      description={t('eyebrow')}
      state={state}
      step={
        done ? (
          <div role="status" data-testid="appeal-signed-out__result" data-status={done.status}>
            <p>
              <strong>{t(`status_${done.status}`)}</strong> {t('sentBody')}
            </p>
            <a className="text-link" href="/login">
              {t('signIn')}
            </a>
          </div>
        ) : (
          <form className="stack" onSubmit={(e) => void send(e)} data-testid="appeal-signed-out__form" noValidate>
            <p>{t('intro')}</p>
            <label htmlFor="appeal-identifier">{t('identifier')}</label>
            <input id="appeal-identifier" name="appeal-identifier" autoComplete="username" />
            <label htmlFor="appeal-password">{t('password')}</label>
            <input
              id="appeal-password"
              name="appeal-password"
              type="password"
              autoComplete="current-password"
              aria-describedby="appeal-password-hint"
            />
            <small id="appeal-password-hint">{t('passwordHint')}</small>
            <label htmlFor="appeal-text">{t('text')}</label>
            <textarea id="appeal-text" name="appeal-text" maxLength={APPEAL_TEXT_MAX} aria-describedby="appeal-text-hint" />
            <small id="appeal-text-hint">{t('textHint', { max: String(APPEAL_TEXT_MAX) })}</small>
            {missing && <p role="alert">{t('missing')}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? t('sending') : t('send')}
            </Button>
          </form>
        )
      }
      help={
        <p>
          <a className="text-link" href="/help">
            {t('help')}
          </a>
        </p>
      }
    />
  );
}
