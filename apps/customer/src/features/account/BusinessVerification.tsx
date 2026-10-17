import { Page } from '../../shared/ui';
import { businessCopy } from './business-verification-copy';
import '../public/public-pages.css';

const STEPS = [
  { path: '/pay/onboarding/business', title: 'step1', body: 'step1Body' },
  { path: '/pay/onboarding/verification', title: 'step2', body: 'step2Body' },
  { path: '/pay/onboarding/go-live', title: 'step3', body: 'step3Body' },
] as const;

/** /identbusiness. Company verification is the merchant set-up in Pay; this page explains it and links each step. */
export function BusinessVerification() {
  const copy = businessCopy.useCopy();
  return (
    <Page title={copy.t('title')} description={copy.t('intro')}>
      <div className="pub-card pub-card--flat">
        <h2>{copy.t('whereTitle')}</h2>
        <p className="muted">{copy.t('whereBody')}</p>
        <ol className="pub-list">
          {STEPS.map((step) => (
            <li key={step.path}>
              <span>
                <strong>{copy.t(step.title)}</strong>
                <span className="muted">{copy.t(step.body)}</span>
              </span>
              <a className="text-link" href={step.path}>
                {copy.t('open')} →
              </a>
            </li>
          ))}
        </ol>
      </div>
      <div className="pub-grid">
        <section className="pub-card">
          <h2>{copy.t('startTitle')}</h2>
          <p>{copy.t('startBody')}</p>
          <a className="button button--primary" href="/pay/merchant">
            {copy.t('startAction')}
          </a>
        </section>
        <section className="pub-card">
          <h2>{copy.t('personalTitle')}</h2>
          <p>{copy.t('personalBody')}</p>
          <a className="text-link" href="/verification">
            {copy.t('personalAction')} →
          </a>
        </section>
      </div>
      <p className="muted">{copy.t('boundary')}</p>
    </Page>
  );
}
