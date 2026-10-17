import { notFound } from 'next/navigation';
import { PageHead } from '@/components/merchants/ui';
import { RegistryForm } from '@/components/merchants/registry-form';
import { registryHref } from '@/components/merchants/registries-view';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';
import { kindFromSlug, REGISTRY_INFO } from '@/lib/merchants/registry-model';

export const dynamic = 'force-dynamic';

export default async function NewRegistryEntryPage({ params }: { params: Promise<{ kind: string }> }) {
  requireModulePage('merchants');
  await requireMerchantsFounder();
  const kind = kindFromSlug((await params).kind);
  if (kind === null) notFound();
  const info = REGISTRY_INFO[kind];
  return (
    <div className="mp-page">
      <PageHead
        title={`Add ${info.singular}`}
        purpose="New entries start switched off. You review the change first; switching something on later needs a second founder."
        back={{ href: registryHref(kind), label: info.title }}
      />
      <RegistryForm kind={kind} mode="create" expectedVersion={null} listHref={registryHref(kind)} />
    </div>
  );
}
