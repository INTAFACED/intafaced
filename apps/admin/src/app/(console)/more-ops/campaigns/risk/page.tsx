import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignsRisk, type RiskInitial } from '@/components/campaigns-risk';
import { checkCase, loadRiskCase, loadRiskQueue } from '@/lib/campaigns-ops/risk-server';

/**
 * The risk review desk (J-campaigns-18): the queue of accounts with duplicate-account, device and anti-churn signals or a
 * reward withheld for the account's status; with an account, its case, and withholding, revoking and the appeal's decision.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ account?: string | string[] }> }) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const raw = (await searchParams).account;
  const checked = checkCase({ accountId: raw });
  const account = checked.ok ? checked.input.accountId : null;
  const initial: RiskInitial = {
    queue: (await loadRiskQueue(founder)).reply,
    account,
    case: account ? (await loadRiskCase(founder, { accountId: account })).reply : null,
  };
  return <CampaignsRisk key={account ?? 'queue'} initial={initial} />;
}
