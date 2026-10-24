import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useDataEnv } from '../../data/hooks';
import { readContract, writeContract, type ContractData } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { Button, Field } from '../../shared/ui';
import {
  statusPageFetcher,
  statusSubscriptionConfirm,
  statusSubscriptionGet,
  statusSubscriptionUpdate,
  statusUnsubscribe,
  type StatusPage,
} from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';
import './public-pages.css';
import './status-page.css';

type View = ContractData<typeof statusSubscriptionGet>;
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof statusSubscribeCopy.useCopy>['t'];

const DEAD = new Set(['status.subscription_link_invalid', 'status.subscriber_unknown']);

/**
 * /status/confirm, /status/manage and /status/unsubscribe (SP-status-04): the pages the links in status mail open. Opening
 * a page changes nothing, so a mail scanner that fetches the link spends nothing; the person presses the button. The
 * token leaves the address bar once read.
 */
export function StatusSubscriptionPage({ mode }: { mode: 'confirm' | 'manage' | 'unsubscribe' }) {
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const token = useRef(new URLSearchParams(location.search).get('token')?.trim() ?? '').current;
  const [manageToken, setManageToken] = useState<string | null>(mode === 'manage' && token ? token : null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (location.search) history.replaceState(history.state, '', location.pathname);
  }, []);

  useEffect(() => {
    if (mode !== 'manage' || !manageToken) return;
    void readContract(api, statusSubscriptionGet, { token: manageToken }).then((answer) =>
      answer.ok ? setView(answer.data) : setRefusal(answer),
    );
  }, [api, mode, manageToken]);

  async function act() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    if (mode === 'confirm') {
      const answer = await writeContract(api, statusSubscriptionConfirm, { token });
      if (answer.ok) {
        const { manageToken: next, ...rest } = answer.data;
        setManageToken(next);
        setView(rest);
      } else setRefusal(answer);
    } else {
      const answer = await writeContract(api, statusUnsubscribe, { token });
      if (answer.ok) setView(answer.data);
      else setRefusal(answer);
    }
    setBusy(false);
  }

  const dead = !token || DEAD.has(refusal?.code ?? '');
  const title = dead
    ? t('deadTitle')
    : mode === 'unsubscribe'
      ? view
        ? t('leftTitle')
        : t('leaveTitle')
      : mode === 'confirm' && view
        ? t('confirmedTitle')
        : mode === 'confirm'
          ? t('confirmTitle')
          : t('manageTitle');
  return (
    <div className="pub-page" data-testid={`status-subscription-${mode}`}>
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{title}</h1>
      </header>
      {dead ? (
        <div className="pub-notice" role="alert" data-testid="status-subscription-dead">
          <p>{t('deadBody')}</p>
          {refusal?.code ? <small lang="zxx">{refusal.code}</small> : null}
        </div>
      ) : mode === 'unsubscribe' && view ? (
        <p role="status" data-testid="status-subscription-left">
          {t('leftBody')}
        </p>
      ) : mode !== 'manage' && !view ? (
        <>
          <p className="muted">{mode === 'confirm' ? t('confirmIntro') : t('leaveIntro')}</p>
          <Button variant={mode === 'unsubscribe' ? 'danger' : 'primary'} onClick={() => void act()} disabled={busy}>
            {mode === 'confirm' ? (busy ? t('confirming') : t('confirm')) : busy ? t('leaving') : t('leave')}
          </Button>
          {refusal ? (
            <p role="alert">
              {t('failed')} <small lang="zxx">{refusal.code}</small>
            </p>
          ) : null}
        </>
      ) : view && manageToken ? (
        <ManageSubscription token={manageToken} view={view} onChange={setView} t={t} />
      ) : (
        <p role="status">{t('manageLoading')}</p>
      )}
      <p>
        <a className="text-link" href="/status">
          {t('toStatus')}
        </a>
      </p>
    </div>
  );
}

function ManageSubscription({ token, view, onChange, t }: { token: string; view: View; onChange: (view: View) => void; t: T }) {
  const { api } = useDataEnv();
  const [components, setComponents] = useState<StatusPage['components']>([]);
  const [all, setAll] = useState(view.componentIds === null);
  const [picked, setPicked] = useState<string[]>(view.componentIds ?? []);
  const [webhook, setWebhook] = useState(view.webhookUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void statusPageFetcher(api)(controller.signal).then((answer) => answer.ok && setComponents(answer.data.components));
    return () => controller.abort();
  }, [api]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setRefusal(null);
    const answer = await writeContract(api, statusSubscriptionUpdate, {
      token,
      componentIds: all ? null : picked,
      webhookUrl: webhook.trim() === '' ? null : webhook.trim(),
    });
    setBusy(false);
    if (answer.ok) {
      onChange(answer.data);
      setSaved(true);
    } else setRefusal(answer);
  }

  async function leave() {
    if (busy) return;
    setBusy(true);
    const answer = await writeContract(api, statusUnsubscribe, { token });
    setBusy(false);
    if (answer.ok) onChange(answer.data);
    else setRefusal(answer);
  }

  return (
    <section className="pub-card status-subscribe" data-testid="status-subscription-manage" data-state={view.state}>
      <dl className="status-subscribe__facts">
        <dt>{t('manageAddress')}</dt>
        <dd>{view.email}</dd>
        <dt>{t('manageState')}</dt>
        <dd data-testid="status-subscription-state">{t(`state_${view.state}`)}</dd>
      </dl>
      {view.state === 'active' ? (
        <form className="status-subscribe__form" onSubmit={(event) => void save(event)}>
          <fieldset className="status-subscribe__components">
            <label>
              <input type="radio" name="scope" checked={all} onChange={() => setAll(true)} /> {t('allComponents')}
            </label>
            <label>
              <input type="radio" name="scope" checked={!all} onChange={() => setAll(false)} /> {t('pickComponents')}
            </label>
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
          <Field
            label={t('webhook')}
            hint={t('webhookHint')}
            type="url"
            name="webhook"
            inputMode="url"
            value={webhook}
            onChange={(event) => setWebhook(event.target.value)}
          />
          <div className="status-subscribe__actions">
            <Button type="submit" disabled={busy || (!all && picked.length === 0)}>
              {busy ? t('saving') : t('save')}
            </Button>
            <Button variant="secondary" onClick={() => void leave()} disabled={busy}>
              {t('leave')}
            </Button>
          </div>
          {saved ? (
            <p role="status" data-testid="status-subscription-saved">
              {t('saved')}
            </p>
          ) : null}
          {refusal ? (
            <p role="alert" data-testid="status-subscription-refused">
              {refusal.code === 'status.webhook_target_refused'
                ? t('webhookRefused')
                : refusal.code === 'status.component_unknown'
                  ? t('componentUnknown')
                  : t('failed')}{' '}
              <small lang="zxx">{refusal.code}</small>
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
