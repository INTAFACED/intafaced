import { TreasuryView } from '@/components/merchants/treasury-view';
import { loadTreasury } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function TreasuryPage() {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  return <TreasuryView data={await loadTreasury(ctx)} />;
}
