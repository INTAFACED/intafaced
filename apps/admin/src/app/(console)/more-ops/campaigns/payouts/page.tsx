import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignsPayouts, type PayoutsInitial } from '@/components/campaigns-payouts';
import { loadDistributionPlan, loadPayoutBoard } from '@/lib/campaigns-ops/payouts-server';

/** A campaign id as the console passes it on: the service's own id shape, never free text. */
const campaignIdOf = (raw: string | string[] | undefined) => (typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw) ? raw : null);

/**
 * The payout board (J-campaigns-19): every reward intent by where it stands on its way to the customer's own wallet, with
 * its keys and ledger and chain references; with `?plan=`, an airdrop's plan account by account and its run.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string | string[]; plan?: string | string[] }>;
}) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const params = await searchParams;
  const campaign = campaignIdOf(params.campaign);
  const plan = campaignIdOf(params.plan);
  const initial: PayoutsInitial = {
    campaign,
    board: (await loadPayoutBoard(founder, campaign ? { campaignId: campaign } : {})).reply,
    plan,
    planAnswer: plan ? (await loadDistributionPlan(founder, { campaignId: plan })).reply : null,
  };
  return <CampaignsPayouts key={`${campaign ?? 'all'}:${plan ?? 'none'}`} initial={initial} />;
}
