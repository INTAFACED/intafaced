import { Failure, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { formatAmount, parseAmount } from '../../shared/money';
import { useSession } from '../session/session';
import { funds, useBankRead } from './components';
import type { AccountTerms } from './contracts';
import { planRuleCopy } from './plan-rule-copy';

/**
 * The plan's rule for paying more than the balance holds (J-bank-02 #8), read from the owner's published terms
 * (`bank.accounts.features`). A plan with no overdraft says payments above the balance are refused. A plan that publishes
 * an overdraft names its fee and the bank's blocker (`bank.overdraft_switched_off`): no overdraft engine exists in this
 * build, so the bank never books a negative balance and the payment is refused. With no published terms nothing is
 * assumed: the rule says so and the refusal stands.
 */
function ruleParts(resource: Resource<AccountTerms>): { words: string; code: string | null } | null {
  const { t } = planRuleCopy;
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed') {
    const code = resource.failure.code;
    if (code === 'bank.account_terms_unset') return { words: t('unset'), code };
    if (code === 'bank.company_account_unwired') return { words: t('company'), code };
    return null;
  }
  const terms = resource.data;
  if (terms.overdraftFee === null) return { words: t('noOverdraft', { tier: terms.tier }), code: null };
  return {
    words: t('overdraft', { tier: terms.tier, fee: funds(terms.overdraftFee, terms.currency) }),
    code: terms.overdraftBlocker ?? 'bank.overdraft_switched_off',
  };
}

/** The plan's rule as one line of text, its reference included, or null while it is loading or unreadable. */
export function planRuleLine(resource: Resource<AccountTerms>): string | null {
  const parts = ruleParts(resource);
  if (!parts) return null;
  return parts.code ? `${parts.words} ${planRuleCopy.t('reference', { code: parts.code })}` : parts.words;
}

/**
 * What the review says when a payment asks for more than its space holds: the shortfall, then the plan's rule. Null when
 * the amount is within the balance or not a number the review can read (the transfer's own checks answer that).
 */
export function overBalanceProblem(resource: Resource<AccountTerms>, from: { balance: string; assetId: string }, asked: unknown) {
  if (typeof asked !== 'string') return null;
  let wanted: bigint;
  let held: bigint;
  try {
    wanted = parseAmount(asked.trim());
    held = parseAmount(from.balance);
  } catch {
    return null;
  }
  if (wanted <= held) return null;
  // `funds` keeps a hidden balance hidden: the shortfall would give it away, so both are masked together.
  const over = planRuleCopy.t('overBalance', {
    shortfall: funds(formatAmount(wanted - held), from.assetId),
    balance: funds(from.balance, from.assetId),
  });
  const rule = planRuleLine(resource);
  return rule ? `${over} ${rule}` : over;
}

export function PlanRuleText({ resource, reload }: { resource: Resource<AccountTerms>; reload?: () => void }) {
  // Subscribes to the language, so the rule re-renders when it changes wherever it is mounted.
  planRuleCopy.useCopy();
  if (resource.status === 'loading') return <Loading />;
  const parts = ruleParts(resource);
  if (!parts) return resource.status === 'failed' ? <Failure result={resource.failure} retry={reload} /> : null;
  return (
    <>
      {parts.words}
      {parts.code && (
        <>
          {' '}
          <small className="muted">{planRuleCopy.t('reference', { code: parts.code })}</small>
        </>
      )}
    </>
  );
}

/** The plan's terms for the active profile, so a room can show the rule and use it in its own review. */
export function usePlanTerms() {
  const { profiles } = useSession();
  return useBankRead('accounts.features', { profile: profiles.active });
}

export function PlanRule({ plan }: { plan: ReturnType<typeof usePlanTerms> }) {
  const { t } = planRuleCopy.useCopy();
  return (
    <div data-testid="plan-rule">
      <h4 className="bd-subhead">{t('title')}</h4>
      <div className="money-caption">
        <PlanRuleText resource={plan.resource} reload={plan.reload} />
      </div>
    </div>
  );
}
