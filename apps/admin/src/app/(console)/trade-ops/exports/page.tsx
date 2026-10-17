import { PageSection } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { BlockerPanel } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ExportsBuilder } from '@/components/trade-ops/exports-builder';
import { ExportsServerForm } from '@/components/trade-ops/exports-server-form';

export const dynamic = 'force-dynamic';

/** Exports: save what the desk can read as CSV (open orders, kill-switch audit, restriction history). Nothing is read until the operator asks. */
export default async function ExportsPage() {
  await requireFounderPage();
  return (
    <DeskPage
      title="Exports"
      description="Save records as CSV for audit or a regulator. The file is built from a fresh read, with exact decimals."
    >
      <PageSection title="Save what is readable now">
        <ExportsBuilder />
      </PageSection>
      <PageSection title="Fills, positions and order history">
        <div className="flex flex-col gap-4">
          <BlockerPanel blocker={BLOCKERS.export_missing} title="Server-side export is not available" size="inline" />
          <ExportsServerForm />
        </div>
      </PageSection>
    </DeskPage>
  );
}
