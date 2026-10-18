import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { auditRowsFromKillSwitch } from '@/lib/trade-ops/audit-rows';
import { readKillSwitchSnapshot } from '@/lib/trade-ops/reads';
import { validateUserId } from '@/lib/trade-ops/restrictions';
import { AuditApprovals } from '@/components/trade-ops/audit-approvals';
import { AuditRestrictions } from '@/components/trade-ops/audit-restrictions';
import { AuditTable } from '@/components/trade-ops/audit-table';
import { BlockerPanel, ReadProblem } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';

export const dynamic = 'force-dynamic';

/** Audit: who changed what, when and why. Three real sources, each in its own panel, and the combined feed named as missing. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ user?: string | string[] }> }) {
  await requireFounderPage();
  const raw = (await searchParams).user;
  const typed = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  const user = typed ? validateUserId(typed) : null;
  const kill = await readKillSwitchSnapshot();

  return (
    <DeskPage
      title="Audit"
      description="Who changed what, when and why: kill switches, trading restrictions and approvals."
      asOf={kill.asOf}
      state={kill.kind === 'ok' ? 'live' : kill.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={kill.kind === 'ok' ? undefined : kill.kind === 'refused' ? kill.code : kill.message}
    >
      <PageSection title="Kill-switch audit">
        {kill.kind === 'ok' ? (
          <AuditTable
            label="Kill-switch audit"
            rows={auditRowsFromKillSwitch(kill.data.audit)}
            emptyText="The edge has recorded no kill-switch changes."
          />
        ) : (
          <ReadProblem outcome={kill} title="Kill-switch audit not read" />
        )}
      </PageSection>
      <PageSection title="Restriction history by user">
        <AuditRestrictions initialUserId={user?.ok ? user.value : ''} />
      </PageSection>
      <PageSection title="Approvals">
        <AuditApprovals />
      </PageSection>
      <PageSection title="Combined feed">
        <BlockerPanel blocker={BLOCKERS.audit_feed_missing} title="No single audit feed exists" size="inline" />
      </PageSection>
    </DeskPage>
  );
}
