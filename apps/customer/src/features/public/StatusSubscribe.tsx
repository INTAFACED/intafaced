import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDataEnv } from '../../data/hooks';
import { readContract, writeContract } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { Button, Field } from '../../shared/ui';
import { solveStatusChallenge, statusSubscribe, statusSubscriptionChallenge, statusSubscriptionPolicy, type StatusPage } from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';

type Policy = Extract<Awaited<ReturnType<typeof readContract<typeof statusSubscriptionPolicy>>>, { ok: true }>['data'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Outcome = { kind: 'sent' } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'refused'; refusal: Refusal };

/**
 * The subscribe form on /status (SP-status-04). Email only: text messages and app notifications are named as not
 * connected. The form solves the service's proof-of-work challenge in the browser before it sends; a blank owner
 * safeguard keeps the form closed with the reason.
 */
export function StatusSubscribe({ components }: { components: StatusPage['components'] }) {
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [policyFailed, setPolicyFailed] = useState(false);
  const [email, setEmail] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function loadPolicy() {
    setPolicyFailed(false);
    const answer = await readContract(api, statusSubscriptionPolicy);
    if (answer.ok) setPolicy(answer.data);
    else setPolicyFailed(true);
  }

  useEffect(() => {
    void loadPolicy();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    abort.current = new AbortController();
    const challenge = await writeContract(api, statusSubscriptionChallenge);
    if (!challenge.ok) {
      setBusy(false);
      setOutcome({ kind: 'refused', refusal: challenge });
      return;
    }
    let nonce: string;
    try {
      nonce = await solveStatusChallenge(challenge.data, abort.current.signal);
    } catch {
      // Left the page (aborted), or this browser cannot hash: either way the form is usable again.
      setBusy(false);
      if (!abort.current.signal.aborted) setOutcome({ kind: 'failed' });
      return;
    }
    const answer = await writeContract(api, statusSubscribe, {
      email,
      componentIds: all ? null : picked,
      challenge: { token: challenge.data.token, nonce },
    });
    setBusy(false);
    if (!answer.ok) setOutcome({ kind: 'refused', refusal: answer });
    else setOutcome({ kind: answer.data.state === 'confirmation_pending' ? 'pending' : 'sent' });
  }

  const closed = policy !== null && (policy.challengeBits === null || !policy.rateLimitSet);
  return (
    <section className="pub-card status-subscribe" aria-labelledby="status-subscribe" data-testid="status-subscribe">
      <h2 id="status-subscribe">{t('title')}</h2>
      <p className="muted">{t('lead')}</p>
      {policy === null && !policyFailed ? <p role="status">{t('policyLoading')}</p> : null}
      {policyFailed ? (
        <p role="alert">
          {t('policyFailed')}{' '}
          <button type="button" className="text-link" onClick={() => void loadPolicy()}>
            {t('retry')}
          </button>
        </p>
      ) : null}
      {policy ? (
        <ul className="status-subscribe__channels" data-testid="status-subscribe-channels">
          {policy.email ? (
            <li data-testid="status-subscribe-email-off">
              {t('emailOff')} <small lang="zxx">{policy.email}</small>
            </li>
          ) : null}
          <li>
            {t('smsOff')} <small lang="zxx">{policy.sms}</small>
          </li>
          <li>
            {t('pushOff')} <small lang="zxx">{policy.push}</small>
          </li>
        </ul>
      ) : null}
      {closed ? (
        <p className="pub-notice" role="status" data-testid="status-subscribe-closed">
          {t('unset')} <small lang="zxx">{policy?.challengeBits === null ? 'status.challenge_unset' : 'status.rate_limit_unset'}</small>
        </p>
      ) : null}
      {policy && !closed ? (
        <form className="status-subscribe__form" onSubmit={(event) => void submit(event)}>
          <Field
            label={t('email')}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <fieldset className="status-subscribe__components">
            <label>
              <input type="radio" name="scope" checked={all} onChange={() => setAll(true)} /> {t('allComponents')}
            </label>
            {components.length > 0 ? (
              <label>
                <input type="radio" name="scope" checked={!all} onChange={() => setAll(false)} /> {t('pickComponents')}
              </label>
            ) : null}
            {!all
              ? components.map((component) => (
                  <label key={component.id} className="status-subscribe__component">
                    <input
                      type="checkbox"
                      name="component"
                      value={component.id}
                      checked={picked.includes(component.id)}
                      onChange={(event) =>
                        setPicked((now) => (event.target.checked ? [...now, component.id] : now.filter((id) => id !== component.id)))
                      }
                    />{' '}
                    {component.name}
                  </label>
                ))
              : null}
          </fieldset>
          <Button type="submit" disabled={busy || (!all && picked.length === 0)}>
            {busy ? t('working') : t('subscribe')}
          </Button>
          {busy ? <p className="muted">{t('workingHint')}</p> : null}
        </form>
      ) : null}
      {outcome?.kind === 'sent' ? (
        <p role="status" data-testid="status-subscribe-sent">
          {t('sent')}
        </p>
      ) : null}
      {outcome?.kind === 'pending' ? (
        <p className="pub-notice" role="status" data-testid="status-subscribe-pending">
          {t('pending')} <small lang="zxx">vendor.email</small>
        </p>
      ) : null}
      {outcome?.kind === 'failed' ? (
        <p role="alert" data-testid="status-subscribe-refused">
          {t('failed')}
        </p>
      ) : null}
      {outcome?.kind === 'refused' ? (
        <p role="alert" data-testid="status-subscribe-refused">
          {refusalText(outcome.refusal.code, t)} {outcome.refusal.code ? <small lang="zxx">{outcome.refusal.code}</small> : null}
        </p>
      ) : null}
    </section>
  );
}

function refusalText(code: string | undefined, t: ReturnType<typeof statusSubscribeCopy.useCopy>['t']): string {
  if (code === 'status.rate_limited') return t('rateLimited');
  if (code === 'status.challenge_failed') return t('challengeFailed');
  if (code === 'status.challenge_unset' || code === 'status.rate_limit_unset') return t('unset');
  if (code === 'status.component_unknown') return t('componentUnknown');
  return t('failed');
}
