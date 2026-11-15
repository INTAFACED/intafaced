import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignsWatch, type WatchInitial } from '@/components/campaigns-watch';
import { loadOverview, loadWatchCampaign } from '@/lib/campaigns-ops/watch-server';

/**
 * The campaign watch desk (J-campaigns-17): every running campaign's KPIs, trend, top campaigns and alerts; with an id,
 * one campaign's participation, vouchers, redemptions, publications, code batches and exports.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const raw = (await searchParams).id;
  const id = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : null;
  const initial: WatchInitial = id
    ? { kind: 'campaign', id, answer: (await loadWatchCampaign(founder, { id })).reply }
    : { kind: 'overview', answer: (await loadOverview(founder)).reply };
  // Keyed on the id, so opening another campaign starts the desk over from its own read.
  return <CampaignsWatch key={id ?? 'overview'} initial={initial} />;
}
