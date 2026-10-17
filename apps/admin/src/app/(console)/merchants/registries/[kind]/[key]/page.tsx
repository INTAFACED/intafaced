import { notFound } from 'next/navigation';
import { HistoryTable, registryHref } from '@/components/merchants/registries-view';
import { RegistryForm } from '@/components/merchants/registry-form';
import { Card, FailureState, PageHead, StatusChip } from '@/components/merchants/ui';
import { routableChip } from '@/lib/merchants/chips';
import { loadRegistry, loadRegistryHistory } from '@/lib/merchants/loaders';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';
import { formFromView, kindFromSlug, REGISTRY_INFO, viewKey, type RegistryFormValues } from '@/lib/merchants/registry-model';
import { formatUtc } from '@/lib/merchants/time';

export const dynamic = 'force-dynamic';

export default async function RegistryEntryPage({ params }: { params: Promise<{ kind: string; key: string }> }) {
  requireModulePage('merchants');
  const ctx = await requireMerchantsFounder();
  const { kind: slug, key: rawKey } = await params;
  const kind = kindFromSlug(slug);
  if (kind === null) notFound();
  const key = decodeURIComponent(rawKey);
  const info = REGISTRY_INFO[kind];
  const list = await loadRegistry(ctx, kind);
  if (list.kind !== 'ok') {
    return (
      <div className="mp-page">
        <PageHead title={info.title} purpose={info.purpose} back={{ href: registryHref(kind), label: info.title }} />
        <FailureState failure={list} what={`This ${info.singular}`} retryHref={registryHref(kind, encodeURIComponent(key))} />
      </div>
    );
  }
  const entry = list.data.find((row) => viewKey(kind, row) === key);
  if (!entry) notFound();
  const history = await loadRegistryHistory(ctx, kind, key);
  const locked: (keyof RegistryFormValues)[] =
    kind === 'venue' ? ['venueId'] : kind === 'network' ? ['networkId'] : ['assetCode', 'networkId'];
  const title = 'displayName' in entry ? entry.displayName : `${entry.assetCode} on ${entry.networkId}`;
  return (
    <div className="mp-page">
      <PageHead
        title={title}
        purpose={`Edit this ${info.singular}. You review the change before it saves.`}
        back={{ href: registryHref(kind), label: info.title }}
      />
      <div className="mp-facts" aria-label="Entry facts">
        <div>
          <span className="mp-facts__k">Status</span>
          <span className="mp-facts__v">
            <StatusChip spec={routableChip(entry.routable, entry.missing)} />
            <span className="mp-muted">
              Version {entry.version} · last changed {formatUtc(entry.updatedAt)} by{' '}
              <span title={entry.updatedBy}>{entry.updatedBy.slice(0, 8)}…</span>
            </span>
          </span>
        </div>
      </div>
      <Card id="edit" title="Edit" sub="Change what you need and press Review change.">
        <RegistryForm
          kind={kind}
          mode="edit"
          initial={formFromView(kind, entry)}
          expectedVersion={entry.version}
          lockedKeys={locked}
          listHref={registryHref(kind)}
        />
      </Card>
      <HistoryTable result={history} kind={kind} entryKey={key} />
    </div>
  );
}
