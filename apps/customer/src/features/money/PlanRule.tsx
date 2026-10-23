import { Failure, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import { funds, useBankRead } from './components';
import type { AccountTerms } from './contracts';
import { planRuleCopy } from './plan-rule-copy';

/**
 * The plan's rule for paying more than the balance holds (J-bank-02 #8), read from the owner's published terms
 * (`bank.accounts.features`). A plan with no overdraft says payments above the balance are refused; one with an
 * overdraft names its fee. With no published terms nothing is assumed: the rule says so and the refusal stands.
 */
export function PlanRuleText({ resource, reload }: { resource: Resource<AccountTerms>; reload?: () => void }) {
  const { t } = planRuleCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed' && resource.failure.code === 'bank.account_terms_unset') {
    return (
      <>
        {t('unset')} <small className="muted">{t('reference', { code: resource.failure.code })}</small>
      </>
    );
  }
  if (resource.status === 'failed' && resource.failure.code === 'bank.company_account_unwired') {
    return (
      <>
        {t('company')} <small className="muted">{t('reference', { code: resource.failure.code })}</small>
      </>
    );
  }
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const terms = resource.data;
  return (
    <>
      {terms.overdraftFee === null
        ? t('noOverdraft', { tier: terms.tier })
        : t('overdraft', { tier: terms.tier, fee: funds(terms.overdraftFee, terms.currency) })}
    </>
  );
}

export function PlanRule() {
  const { t } = planRuleCopy.useCopy();
  const { profiles } = useSession();
  const read = useBankRead('accounts.features', { profile: profiles.active });
  return (
    <div data-testid="plan-rule">
      <h4 className="bd-subhead">{t('title')}</h4>
      <div className="money-caption">
        <PlanRuleText resource={read.resource} reload={read.reload} />
      </div>
    </div>
  );
}
