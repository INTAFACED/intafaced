import { EmptyState } from '@intafaced/ui/lit';
import { ReadingTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { defineCopy } from '../../../shared/i18n';
import { ApiFailure } from './ApiFailure';
import { SUPPORT_SAFETY_MULE_POLICY } from '@intafaced/contracts/support-safety-procedures';

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
 * `/help/mule-policy` (BK-safe-02, J-bank-18 #3), on the reading template: the owner's money-mule policy from
 * `support.safety.mulePolicy`, or, with none published, a notice that says so rather than words of ours. The ways to report
 * stay either way.
 */
export function MulePolicyRoom() {
  const { t, languageFor } = copy.useCopy();
  const { api } = useSession();
  const { resource, reload } = useResource((signal) => api.call(SUPPORT_SAFETY_MULE_POLICY, undefined, { signal }), 'mule-policy');
  const state: RoomState = resource.status === 'loading' ? { kind: 'loading' } : { kind: 'ready' };
  return (
    <div data-testid="mule-policy" lang={languageFor('title')}>
      <ReadingTemplate
        title={t('title')}
        description={t('intro')}
        state={state}
        body={
          resource.status === 'failed' ? (
            <ApiFailure result={resource.failure} retry={reload} />
          ) : resource.status === 'ready' && !resource.data.published ? (
            <div role="status" data-testid="mule-policy__unpublished">
              <EmptyState title={t('unpublished')} />
            </div>
          ) : resource.status === 'ready' && resource.data.published ? (
            <p data-testid="mule-policy__text" className="lt-pre-line">
              {resource.data.text}
            </p>
          ) : null
        }
        related={
          <section aria-labelledby="mule-report" className="lt-stack">
            <h2 id="mule-report">{t('reportTitle')}</h2>
            <p>{t('reportBody')}</p>
            <ul>
              <li>
                <a className="lt-link lt-link-alone" href="/bank/safety/scam">
                  {t('reportScam')}
                </a>
              </li>
              <li>
                <a className="lt-link lt-link-alone" href="/support/new">
                  {t('contactSupport')}
                </a>
              </li>
            </ul>
          </section>
        }
      />
    </div>
  );
}
