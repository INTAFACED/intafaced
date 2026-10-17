import { notFound } from 'next/navigation';
import { RegistryListView } from '@/components/merchants/registries-view';
import { loadRegistry } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';
import { kindFromSlug } from '@/lib/merchants/registry-model';

export const dynamic = 'force-dynamic';

export default async function RegistryListPage({ params }: { params: Promise<{ kind: string }> }) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const kind = kindFromSlug((await params).kind);
  if (kind === null) notFound();
  return <RegistryListView kind={kind} result={await loadRegistry(ctx, kind)} />;
}
