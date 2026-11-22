import { useEffect, useState } from 'react';
import { useDataEnv } from '../../data/hooks';
import { readContract } from '../../shared/contract-call';
import { Button, Field } from '../../shared/ui';
import { statusSubscriptionGet } from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';
import { DEAD, useLinkToken, useManageSubscription, type Refusal, type T, type View } from './status-subscription';
import { StatusSubscriptionFlow } from './StatusSubscriptionFlow';
import '../../shared/public-pages.css';
import './status-page.css';

/**
 * /status/manage (SP-status-04): the page the manage link in status mail opens. Opening it changes nothing; the token
 * leaves the address bar once read. /status/confirm and /status/unsubscribe are StatusSubscriptionFlow, on the flow
 * template; this name still answers for them.
 */
export function StatusSubscriptionPage({ mode }: { mode: 'confirm' | 'manage' | 'unsubscribe' }) {
  if (mode !== 'manage') return <StatusSubscriptionFlow mode={mode} />;
  return <StatusSubscriptionManage />;
}

function StatusSubscriptionManage() {
  const mode = 'manage';
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const token = useLinkToken();
  const [manageToken] = useState<string | null>(token ? token : null);
  const [view, setView] = useState<View | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (!manageToken) return;
    void readContract(api, statusSubscriptionGet, { token: manageToken }).then((answer) =>
      answer.ok ? setView(answer.data) : setRefusal(answer),
    );
  }, [api, manageToken]);

  const dead = !token || DEAD.has(refusal?.code ?? '');
  const title = dead ? t('deadTitle') : t('manageTitle');
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
  const { components, all, setAll, picked, setPicked, webhook, setWebhook, busy, saved, refusal, save, leave } = useManageSubscription({
    token,
    view,
    onChange,
  });

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
