// volt-room: /identbusiness
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { businessCopy } from './business-verification-copy';

const STEPS = [
  { path: '/pay/onboarding/business', title: 'step1', body: 'step1Body' },
  { path: '/pay/onboarding/verification', title: 'step2', body: 'step2Body' },
  { path: '/pay/onboarding/go-live', title: 'step3', body: 'step3Body' },
] as const;

/**
 * /identbusiness, on the flow template. Company verification is the merchant set-up in Pay; this page explains it and
 * links each step.
 */
export function BusinessVerification() {
  const copy = businessCopy.useCopy();
  return (
    <FlowTemplate
      title={copy.t('title')}
      description={copy.t('intro')}
      state={{ kind: 'ready' }}
      step={
        <section aria-labelledby="identbusiness-where">
          <h2 id="identbusiness-where">{copy.t('whereTitle')}</h2>
          <p className="lt-hint">{copy.t('whereBody')}</p>
          <ol>
            {STEPS.map((step) => (
              <li key={step.path}>
                <span>
                  <strong>{copy.t(step.title)}</strong> <span className="lt-hint">{copy.t(step.body)}</span>
                </span>{' '}
                <a className="lt-link" href={step.path}>
                  {copy.t('open')}
                </a>
              </li>
            ))}
          </ol>
          <p className="lt-hint">{copy.t('boundary')}</p>
        </section>
      }
      actions={
        <a className="lt-button lt-button-primary" href="/pay/merchant">
          {copy.t('startAction')}
        </a>
      }
      summary={
        <div>
          <section aria-labelledby="identbusiness-start">
            <h2 id="identbusiness-start">{copy.t('startTitle')}</h2>
            <p>{copy.t('startBody')}</p>
          </section>
          <section aria-labelledby="identbusiness-personal">
            <h2 id="identbusiness-personal">{copy.t('personalTitle')}</h2>
            <p>{copy.t('personalBody')}</p>
            <a className="lt-link" href="/verification">
              {copy.t('personalAction')}
            </a>
          </section>
        </div>
      }
    />
  );
}
