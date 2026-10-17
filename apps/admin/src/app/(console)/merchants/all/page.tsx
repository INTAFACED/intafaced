import { MerchantsListView } from '@/components/merchants/merchants-list';
import { parseMerchantListQuery, type SearchParams } from '@/lib/merchants/list-params';
import { loadMerchantListPage } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function AllMerchantsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const query = parseMerchantListQuery(await searchParams);
  const data = await loadMerchantListPage(ctx, query);
  return <MerchantsListView data={data} query={query} />;
}
