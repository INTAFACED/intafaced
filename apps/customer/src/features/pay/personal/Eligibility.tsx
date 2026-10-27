import { StatusTag } from '@intafaced/ui';
import { useResource } from '../../../shared/resource';
import { PaySection, PayState } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { P2PEligibility } from '../schemas';
import { eligibilityCopy } from './p2p-eligibility-copy';

type CopyT = ReturnType<typeof eligibilityCopy.useCopy>['t'];
type Check = P2PEligibility['checks'][number];

/** One check's reason in words. The service sends a code; the words are the app's. */
export function eligibilityReason(t: CopyT, check: Check): string {
  const { id, state, reason } = check;
  if (id === 'verification') {
    if (state === 'met') return t('reason_verified', { tier: reason.replace(/^tier\./, '') });
    if (reason === 'denied.kyc_required') return t('reason_kyc');
    return t('reason_region_first');
  }
  if (id === 'contact') {
    if (state === 'met') return t('reason_contact_ok');
    return reason === 'p2p.contact_required' ? t('reason_contact_needed') : t('reason_contact_unknown');
  }
  if (id === 'jurisdiction') {
    if (state === 'met') return t('reason_region_ok');
    if (reason.startsWith('denied.screening')) return t('reason_screening');
    if (reason.startsWith('denied.region')) return t('reason_region_blocked');
    return t('reason_other');
  }
  if (id === 'deposit') return t('reason_deposit');
  return t('reason_other');
}

/**
 * How P2P works and the scams to watch for, always shown beside a take. Guidance only: nothing to tick or accept, and
 * nothing is sent (owner decision 2026-10-27 dropped the forced acceptance, not the advice).
 */
export function StaySafe() {
  const { t } = eligibilityCopy.useCopy();
  return (
    <section className="p2p-stay-safe" aria-label={t('safeTitle')} data-testid="p2p-stay-safe">
      <h4>{t('safeTitle')}</h4>
      <p className="muted">{t('safeIntro')}</p>
      <ul className="p2p-risk-points">
        <li>{t('safeRole')}</li>
        <li>{t('safeOutside')}</li>
        <li>{t('safeProhibited')}</li>
        <li>{t('safeFakeReceipt')}</li>
        <li>{t('safePhishing')}</li>
        <li>{t('safeMiddle')}</li>
        <li>{t('safePressure')}</li>
        <li>{t('safeCancelAfterPay')}</li>
      </ul>
    </section>
  );
}

/**
 * Every requirement for taking an ad, as `access.eligibility` reports it: met, not met with the step that fixes it, or
 * unknown. `compact` lists only what is not met (the ad's take panel); the hub lists all of them.
 */
export function P2PEligibilityPanel({ pay, userId, compact = false }: { pay: PersonalPayApi; userId: string | null; compact?: boolean }) {
  const { t } = eligibilityCopy.useCopy();
  const eligibility = useResource((signal) => pay.eligibility(signal), `pay:p2p-eligibility:${userId}`);
  if (compact && eligibility.resource.status === 'ready' && eligibility.resource.data.canTake) return null;
  return (
    <PaySection title={t('title')} description={compact ? undefined : t('intro')}>
      <div aria-label={t('title')} role="region" data-testid="p2p-eligibility">
        <PayState resource={eligibility.resource} retry={eligibility.reload}>
          {(data) => (
            <>
              <p data-testid={data.canTake ? undefined : 'failure'} className={data.canTake ? 'muted' : 'failure'} role="status">
                {data.canTake ? t('allMet') : t('someUnmet')}
              </p>
              <ul className="p2p-eligibility">
                {data.checks
                  .filter((check) => !compact || check.state !== 'met')
                  .map((check) => (
                    <li key={check.id} data-check={check.id} data-state={check.state}>
                      <strong>{t(`check_${check.id}` as const)}</strong>{' '}
                      <StatusTag
                        status={check.state === 'met' ? 'filled' : check.state === 'not_met' ? 'failed' : 'pending'}
                        label={t(`state_${check.state}` as const)}
                      />
                      <p className="muted">{eligibilityReason(t, check)}</p>
                      {check.state === 'not_met' && check.fix ? (
                        <a className="text-link" href={check.fix}>
                          {check.id === 'verification' ? t('fix_verification') : t('fix_contact')}
                        </a>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </PayState>
      </div>
    </PaySection>
  );
}
