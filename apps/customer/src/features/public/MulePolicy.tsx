import { supportMulePolicySchema } from '@intafaced/contracts/support-safety';
import { Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { defineCopy } from '../../shared/i18n';
import './help.css';

const copy = defineCopy('public.mule-policy', {
  title: 'Money mule policy',
  intro: 'A money mule is someone who receives money and passes it on for someone else. This page holds our policy on it.',
  unpublished: 'The owner has not published the money mule policy.',
  reportTitle: 'Report a suspected mule account',
  reportBody: 'Tell us through a support request. If you sent money because of a scam, report the scam with the transfer it went out on.',
  reportScam: 'Report a scam',
  contactSupport: 'Contact support',
});

/**
 * `/help/mule-policy` (BK-safe-02, J-bank-18 #3): the owner's money-mule policy from `support.safety.mulePolicy`, or, with
 * none published, a notice that says so rather than words of ours. The ways to report stay either way.
 */
export function MulePolicy() {
  const { t, languageFor } = copy.useCopy();
  const { api } = useSession();
  const { resource, reload } = useResource(
    (signal) => api.query('support', 'safety.mulePolicy', undefined, supportMulePolicySchema, { signal }),
    'mule-policy',
  );
  return (
    <div data-testid="mule-policy" className="help stack" lang={languageFor('title')}>
      <header>
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </header>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && !resource.data.published && (
        <p className="notice" role="status" data-testid="mule-policy__unpublished">
          {t('unpublished')}
        </p>
      )}
      {resource.status === 'ready' && resource.data.published && (
        <p data-testid="mule-policy__text" style={{ whiteSpace: 'pre-line' }}>
          {resource.data.text}
        </p>
      )}
      <section aria-labelledby="mule-report">
        <h2 id="mule-report">{t('reportTitle')}</h2>
        <p>{t('reportBody')}</p>
        <ul>
          <li>
            <a className="text-link" href="/bank/safety/scam">
              {t('reportScam')}
            </a>
          </li>
          <li>
            <a className="text-link" href="/support/new">
              {t('contactSupport')}
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
