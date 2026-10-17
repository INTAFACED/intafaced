import { notFound } from 'next/navigation';
import { FounderScreenView } from '@/components/founder-ops/screens';
import { drilldownScreen } from '@/lib/founder-ops/screens';
import { loadOps } from '@/lib/founder-ops/loaders';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';
import { requireModulePage } from '@/lib/module-page-guard';
export const dynamic = 'force-dynamic';
export default async function DrilldownPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; section: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const { id, section } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || section.length !== 1) notFound();
  const screen = drilldownScreen(section[0]!);
  if (!screen) notFound();
  const merchantId = id.toLowerCase();
  const query = (await searchParams) ?? {};
  const data = await loadOps(ctx, screen, undefined, 7, { merchantId, query });
  return (
    <FounderScreenView screen={screen} data={data} path={`/merchants/${merchantId}/${section[0]}`} merchantId={merchantId} query={query} />
  );
}
