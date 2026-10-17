import { DashboardView } from '@/components/merchants/dashboard';
import { loadDashboard } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function MerchantsHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const params = await searchParams;
  const data = await loadDashboard(ctx);
  const asset = typeof params.asset === 'string' ? params.asset : undefined;
  return <DashboardView data={data} asset={asset} />;
}
