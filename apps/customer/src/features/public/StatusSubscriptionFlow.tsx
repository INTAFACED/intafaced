import { useState } from 'react';
import { Button, Choice, Field, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useDataEnv } from '../../data/hooks';
import { writeContract } from '../../shared/contract-call';
import { statusSubscriptionConfirm, statusUnsubscribe } from './status';
import { statusSubscribeCopy } from './status-subscribe-copy';
import { DEAD, useLinkToken, useManageSubscription, type Refusal, type T, type View } from './status-subscription';

/**
 * /status/confirm and /status/unsubscribe (SP-status-04), on the flow template: the pages the links in status mail open.
 * Opening a page changes nothing, so a mail scanner that fetches the link spends nothing; the person presses the button.
 * The token leaves the address bar once read. A confirmed subscription shows its choices here, as /status/manage does.
 */
export function StatusSubscriptionFlow({ mode }: { mode: 'confirm' | 'unsubscribe' }) {
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const token = useLinkToken();
  const [manageToken, setManageToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

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
      : view
        ? t('confirmedTitle')
        : t('confirmTitle');
  return (
    <div data-testid={`status-subscription-${mode}`}>
      <FlowTemplate
        title={title}
        description={t('eyebrow')}
        state={{ kind: 'ready' }}
        step={
          dead ? (
            <RefusalBox
              refusal={{ variant: 'refused', title: t('deadBody'), body: '', ...(refusal?.code ? { reference: refusal.code } : {}) }}
              role="alert"
              data-testid="status-subscription-dead"
            />
          ) : mode === 'unsubscribe' && view ? (
            <p role="status" data-testid="status-subscription-left">
              {t('leftBody')}
            </p>
          ) : !view ? (
            <>
              <p>{mode === 'confirm' ? t('confirmIntro') : t('leaveIntro')}</p>
              <Button tone="primary" onClick={() => void act()} disabled={busy}>
                {mode === 'confirm' ? (busy ? t('confirming') : t('confirm')) : busy ? t('leaving') : t('leave')}
              </Button>
              {refusal ? (
                <RefusalBox
                  refusal={{ variant: 'refused', title: t('failed'), body: '', ...(refusal.code ? { reference: refusal.code } : {}) }}
                  role="alert"
                />
              ) : null}
            </>
          ) : manageToken ? (
            <ManageSubscription token={manageToken} view={view} onChange={setView} t={t} />
          ) : (
            <p role="status">{t('manageLoading')}</p>
          )
        }
        help={
          <p>
            <a className="lt-link" href="/status">
              {t('toStatus')}
            </a>
          </p>
        }
      />
    </div>
  );
}

/** A confirmed subscription's choices: which components, an optional webhook, or leave. */
function ManageSubscription({ token, view, onChange, t }: { token: string; view: View; onChange: (view: View) => void; t: T }) {
  const { components, all, setAll, picked, setPicked, webhook, setWebhook, busy, saved, refusal, save, leave } = useManageSubscription({
    token,
    view,
    onChange,
  });
  return (
    <section data-testid="status-subscription-manage" data-state={view.state}>
      <dl className="lt-kv">
        <div>
          <dt>{t('manageAddress')}</dt>
          <dd>{view.email}</dd>
        </div>
        <div>
          <dt>{t('manageState')}</dt>
          <dd data-testid="status-subscription-state">{t(`state_${view.state}`)}</dd>
        </div>
      </dl>
      {view.state === 'active' ? (
        <form onSubmit={(event) => void save(event)}>
          <fieldset>
            <Choice type="radio" name="scope" checked={all} onChange={() => setAll(true)} label={t('allComponents')} />
            <Choice type="radio" name="scope" checked={!all} onChange={() => setAll(false)} label={t('pickComponents')} />
            {!all
              ? components.map((component) => (
                  <Choice
                    key={component.id}
                    type="checkbox"
                    name="component"
                    value={component.id}
                    checked={picked.includes(component.id)}
                    onChange={(event) =>
                      setPicked((now) => (event.target.checked ? [...now, component.id] : now.filter((id) => id !== component.id)))
                    }
                    label={component.name}
                  />
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
            <RefusalBox
              refusal={{
                variant: 'refused',
                title:
                  refusal.code === 'status.webhook_target_refused'
                    ? t('webhookRefused')
                    : refusal.code === 'status.component_unknown'
                      ? t('componentUnknown')
                      : t('failed'),
                body: '',
                ...(refusal.code ? { reference: refusal.code } : {}),
              }}
              role="alert"
              data-testid="status-subscription-refused"
            />
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
