import { useEffect, useState, type FormEvent } from 'react';
import { useLinkToken } from './status-link-token';
import { Button, Checkbox, Field, Radio } from '@intafaced/ui/lit';
import { KeyValue, SettingsTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useDataEnv } from '../../data/hooks';
import { readContract, writeContract, type ContractData } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { statusPageFetcher, statusSubscriptionGet, statusSubscriptionUpdate, statusUnsubscribe, type StatusPage } from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';

export type View = ContractData<typeof statusSubscriptionGet>;
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof statusSubscribeCopy.useCopy>['t'];

/** Codes that mean the link in the mail no longer opens anything. */
export const DEAD = new Set(['status.subscription_link_invalid', 'status.subscriber_unknown']);

/**
 * /status/manage (SP-status-04), on the settings template: the subscription a status mail's manage link opens, what it
 * covers, its webhook, and Unsubscribe. Opening the page changes nothing; the token leaves the address bar once read.
 */
export function StatusManageRoom() {
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const token = useLinkToken();
  const manageToken = token || null;
  const [view, setView] = useState<View | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (!manageToken) return;
    void readContract(api, statusSubscriptionGet, { token: manageToken }).then((answer) =>
      answer.ok ? setView(answer.data) : setRefusal(answer),
    );
  }, [api, manageToken]);

  const dead = !token || DEAD.has(refusal?.code ?? '');
  let state: RoomState = { kind: 'ready' };
  let sections = null;
  if (dead)
    sections = (
      <div className="lt-refusal" role="alert" data-testid="status-subscription-dead">
        <p className="lt-refusal-body">{t('deadBody')}</p>
        {refusal?.code ? (
          <small className="lt-ref" lang="zxx">
            {refusal.code}
          </small>
        ) : null}
      </div>
    );
  else if (view && manageToken) sections = <ManageSubscription token={manageToken} view={view} onChange={setView} t={t} />;
  else state = { kind: 'loading' };
  return (
    <SettingsTemplate
      title={dead ? t('deadTitle') : t('manageTitle')}
      description={t('eyebrow')}
      state={state}
      index={
        <nav aria-label={t('sectionsLabel')}>
          <ul>
            <li>
              <a className="lt-link" href="/status">
                {t('toStatus')}
              </a>
            </li>
          </ul>
        </nav>
      }
      sections={sections}
      explain={state.kind === 'loading' ? <p role="status">{t('manageLoading')}</p> : <p>{t('manageExplain')}</p>}
    />
  );
}

/** One subscription: its address and state, what it covers, its webhook, Save and Unsubscribe. */
export function ManageSubscription({ token, view, onChange, t }: { token: string; view: View; onChange: (view: View) => void; t: T }) {
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
    <section data-testid="status-subscription-manage" data-state={view.state}>
      <KeyValue
        rows={[
          { label: t('manageAddress'), value: view.email },
          { label: t('manageState'), value: <span data-testid="status-subscription-state">{t(`state_${view.state}`)}</span> },
        ]}
      />
      {view.state === 'active' ? (
        <form onSubmit={(event) => void save(event)}>
          <fieldset>
            <Radio name="scope" checked={all} onSelect={() => setAll(true)}>
              {t('allComponents')}
            </Radio>
            <Radio name="scope" checked={!all} onSelect={() => setAll(false)}>
              {t('pickComponents')}
            </Radio>
            {!all
              ? components.map((component) => (
                  <Checkbox
                    key={component.id}
                    name="component"
                    value={component.id}
                    checked={picked.includes(component.id)}
                    onCheckedChange={(on) => setPicked((now) => (on ? [...now, component.id] : now.filter((id) => id !== component.id)))}
                  >
                    {component.name}
                  </Checkbox>
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
          <div className="lt-actions">
            <Button tone="primary" type="submit" disabled={busy || (!all && picked.length === 0)}>
              {busy ? t('saving') : t('save')}
            </Button>
            <Button tone="secondary" onClick={() => void leave()} disabled={busy}>
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
