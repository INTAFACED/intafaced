import { notFound } from 'next/navigation';
import { MerchantDetailView, parseTab } from '@/components/merchants/merchant-detail';
import { dayOf } from '@/lib/merchants/dates';
import { loadMerchantDetail, parsePreset } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MerchantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const { id } = await params;
  // A malformed id and an id that does not exist look the same (M1: no existence leak).
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const preset = parsePreset(query.window);
  const now = new Date();
  const data = await loadMerchantDetail(ctx, id.toLowerCase(), preset, now);
  if (data.metrics.kind === 'not_found' || data.series.kind === 'not_found') notFound();
  return (
    <MerchantDetailView
      merchantId={id.toLowerCase()}
      data={data}
      tab={parseTab(query.tab)}
      preset={preset}
      asset={typeof query.asset === 'string' ? query.asset : undefined}
      today={dayOf(now)}
    />
  );
}
