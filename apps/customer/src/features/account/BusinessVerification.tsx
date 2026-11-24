// volt-room: /identbusiness
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { businessCopy } from './business-verification-copy';

const STEPS = [
  { path: '/pay/onboarding/business', title: 'step1', body: 'step1Body' },
  { path: '/pay/onboarding/verification', title: 'step2', body: 'step2Body' },
  { path: '/pay/onboarding/go-live', title: 'step3', body: 'step3Body' },
] as const;

/** /identbusiness. Company verification is the merchant set-up in Pay; this page explains it and links each step. */
export function BusinessVerification() {
  const copy = businessCopy.useCopy();
  return (
    <div lang={copy.languageFor('title')}>
      <FlowTemplate
        title={copy.t('title')}
        description={copy.t('intro')}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-sections">
            <section className="lt-stack">
              <h2>{copy.t('whereTitle')}</h2>
              <p className="lt-muted">{copy.t('whereBody')}</p>
              <ol className="lt-list lt-list-rule">
                {STEPS.map((step) => (
                  <li key={step.path} className="lt-row lt-row-between">
                    <span className="lt-stack-tight">
                      <strong>{copy.t(step.title)}</strong>
                      <span className="lt-muted">{copy.t(step.body)}</span>
                    </span>
                    <a className="lt-link" href={step.path}>
                      {copy.t('open')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ol>
            </section>
            <p className="lt-muted">{copy.t('boundary')}</p>
          </div>
        }
        summary={
          <div className="lt-sections">
            <section className="lt-stack">
              <h2>{copy.t('startTitle')}</h2>
              <p className="lt-muted">{copy.t('startBody')}</p>
              <div className="lt-actions">
                <a className="lt-button lt-button-primary" href="/pay/merchant">
                  {copy.t('startAction')}
                </a>
              </div>
            </section>
            <section className="lt-stack">
              <h2>{copy.t('personalTitle')}</h2>
              <p className="lt-muted">{copy.t('personalBody')}</p>
              <a className="lt-link" href="/verification">
                {copy.t('personalAction')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
            </section>
          </div>
        }
      />
    </div>
  );
}
