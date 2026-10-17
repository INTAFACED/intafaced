import { notFound, redirect } from 'next/navigation';
import { FounderScreenView } from '@/components/founder-ops/screens';
import { FounderOpsShell } from '@/components/founder-ops/shell';
import { resolveScreen } from '@/lib/founder-ops/screens';
import { loadOps } from '@/lib/founder-ops/loaders';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';
import { requireModulePage } from '@/lib/module-page-guard';

export const dynamic = 'force-dynamic';
const ALIASES: Record<string, string> = {
  '/approvals': '/merchants/approvals',
  '/halts': '/merchants/treasury',
  '/treasury': '/merchants/treasury',
  '/conversion/venues': '/merchants/registries/venues',
  '/conversion/venues/form': '/merchants/registries/venues/new',
  '/conversion/networks': '/merchants/registries/networks',
  '/conversion/networks/form': '/merchants/registries/networks/new',
  '/conversion/wallets': '/merchants/registries/wallet-routes',
  '/conversion/wallets/form': '/merchants/registries/wallet-routes/new',
};
export default async function FounderOpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ founderPath: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const path = `/${(await params).founderPath.join('/')}`;
  if (ALIASES[path]) redirect(ALIASES[path]);
  const registry = path.match(/^\/conversion\/(venues|wallets)\/([^/]+)$/);
  if (registry)
    redirect(`/merchants/registries/${registry[1] === 'wallets' ? 'wallet-routes' : 'venues'}/${encodeURIComponent(registry[2]!)}`);
  const resolved = resolveScreen(path);
  if (!resolved) notFound();
  const query = await searchParams;
  const merchantFilter = typeof query.merchant === 'string' && query.merchant.length <= 128 ? query.merchant.trim() : '';
  const data = await loadOps(
    ctx,
    resolved.screen,
    merchantFilter || undefined,
    query.window === 'today' ? 1 : query.window === '30d' ? 30 : 7,
    { query },
  );
  const view = (
    <FounderScreenView
      screen={resolved.screen}
      data={data}
      path={path}
      resourceId={resolved.resourceId}
      merchantFilter={merchantFilter}
      query={query}
    />
  );
  return path.startsWith('/merchants/') ? view : <FounderOpsShell>{view}</FounderOpsShell>;
}
