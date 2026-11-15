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
import { TradeAuditTable } from '@/components/trade-ops/trade-audit-table';
import { readTradeAudit } from '@/lib/trade-ops/desk-reads';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { TradeAuditRow } from '@/lib/trade-ops/order-read';

const AUDIT_KIND = /^[a-z][a-z0-9_.]{0,79}$/;
/** At most this many pages of the trade audit are read for one filter; a longer trail says so. */
const TRADE_AUDIT_PAGES = 10;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

/** Every row of the trade operator audit for this filter, oldest first, up to TRADE_AUDIT_PAGES pages. */
async function tradeAudit(
  ctx: Parameters<typeof readTradeAudit>[0],
  filter: { kind?: string; accountId?: string },
): Promise<Outcome<{ rows: TradeAuditRow[]; more: boolean }>> {
  const rows: TradeAuditRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < TRADE_AUDIT_PAGES; page++) {
    const got = await readTradeAudit(ctx, { ...filter, ...(cursor ? { cursor } : {}) });
    if (got.kind !== 'ok') return got;
    rows.push(...got.data.rows);
    if (!got.data.nextCursor) return { kind: 'ok', data: { rows, more: false }, asOf: got.asOf };
    cursor = got.data.nextCursor;
  }
  return { kind: 'ok', data: { rows, more: true }, asOf: new Date().toISOString() };
}

export const dynamic = 'force-dynamic';

/** Audit: who changed what, when and why. Three real sources, each in its own panel, and the combined feed named as missing. */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string | string[]; kind?: string | string[]; account?: string | string[] }>;
}) {
  const { session, config } = await requireFounderPage();
  const params = await searchParams;
  const raw = params.user;
  const typed = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  const user = typed ? validateUserId(typed) : null;
  const kill = await readKillSwitchSnapshot();
  const kind = one(params.kind);
  const accountTyped = one(params.account);
  const account = accountTyped ? validateUserId(accountTyped) : null;
  const filterProblem = kind && !AUDIT_KIND.test(kind) ? 'That is not an audit kind.' : account && !account.ok ? account.message : null;
  const trade =
    filterProblem === null
      ? await tradeAudit({ session, config }, { ...(kind ? { kind } : {}), ...(account?.ok ? { accountId: account.value } : {}) })
      : null;

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
      <PageSection title="Trade operator audit">
        <form method="get" className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-fg-3">Kind (for example orders.get)</span>
            <input name="kind" defaultValue={kind} className="border border-line bg-transparent px-2 py-1" autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-fg-3">Customer account (user id)</span>
            <input name="account" defaultValue={accountTyped} className="border border-line bg-transparent px-2 py-1" autoComplete="off" />
          </label>
          <button type="submit" className="border border-line px-3 py-1">
            Show rows
          </button>
        </form>
        {filterProblem !== null ? (
          <p className="text-sm text-error" role="alert">
            {filterProblem}
          </p>
        ) : trade && trade.kind === 'ok' ? (
          <>
            <TradeAuditTable rows={trade.data.rows} />
            {trade.data.more ? (
              <p className="mt-2 text-xs text-fg-3">More rows match than this page reads; narrow the kind or the account.</p>
            ) : null}
          </>
        ) : trade ? (
          <ReadProblem outcome={trade} title="Trade operator audit not read" />
        ) : null}
      </PageSection>
      <PageSection title="Combined feed">
        <BlockerPanel blocker={BLOCKERS.audit_feed_missing} title="No single audit feed exists" size="inline" />
      </PageSection>
    </DeskPage>
  );
}
