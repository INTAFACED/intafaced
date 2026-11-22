import { bankAccountOnboardingSchema as onboardingSchema } from '@intafaced/contracts/bank-money-room';
import { bankAccountCopy, useAccountRead } from '../bank-account/BankAccountRoom';

/**
 * The onboarding banner on the Bank's first page (J-bank-17 #1): shown while the partner's onboarding has an open step,
 * request or review. A person whose bank account the partner does not hold sees nothing.
 */
export function OnboardingBanner() {
  const { t } = bankAccountCopy.useCopy();
  const read = useAccountRead('onboarding', onboardingSchema, 0);
  if (read.state !== 'ready') return null;
  const now = read.data;
  const openSteps = now.steps.filter((step) => step.status === 'open').length;
  if (now.complete && now.openRequests === 0 && now.openReviews === 0) return null;
  return (
    <section className="lt-stack" data-testid="bank-onboarding-banner" aria-label={t('bannerTitle')} role="region">
      <h3>{t('bannerTitle')}</h3>
      <p className="lt-hint">
        {t('bannerBody', {
          partner: now.label,
          steps: String(openSteps),
          requests: String(now.openRequests),
          reviews: String(now.openReviews),
        })}
      </p>
      <div className="lt-actions">
        <a className="lt-button lt-button-primary" href="/bank/account">
          {t('bannerOpen')}
        </a>
      </div>
    </section>
  );
}
