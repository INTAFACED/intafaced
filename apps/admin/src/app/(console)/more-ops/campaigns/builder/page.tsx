import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignBuilder } from '@/components/campaigns-builder';
import { loadCampaignDetail } from '@/lib/campaigns-ops/builder-server';

/** The campaign builder. Without an id it starts a new draft; with one it resumes that campaign at its first blank step. */
export default async function Page({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const raw = (await searchParams).id;
  const id = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : null;
  // Keyed on the id, so opening another draft starts the builder over from that draft's own state.
  return <CampaignBuilder key={id ?? 'new'} initial={id ? await loadCampaignDetail(founder, id) : null} />;
}
