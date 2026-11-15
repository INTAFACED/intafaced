import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { QuantHaltDesk } from '@/components/trade-ops/quant-halt-desk';
import { QuantLimitsDesk } from '@/components/quant-limits-desk';
import { QuantPromotionAuditDesk } from '@/components/quant-promotion-audit';
import { readHaltDesk } from '@/lib/trade-ops/quant-halts-calls';
import { loadPromotionAudit } from '@/lib/quant-promotion-audit/server';

/**
 * The quant desk (J-algo-dev-11): every live strategy run, halt one or every strategy, and restore, from svc-trade. Below
 * it, plan quotas and sandbox limits (J-algo-dev-12) and the promotion audit (J-algo-dev-13 #3), from svc-quant.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const { session, config } = await requireFounderPage();
  const [read, audit] = await Promise.all([readHaltDesk({ session, config }), loadPromotionAudit({ session, config })]);
  return (
    <DeskPage
      title="Quant desk"
      description="Every live strategy run with its owner, state and version. Halt one strategy, or every strategy with a second founder; restoring needs a second founder too."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      <QuantHaltDesk initial={read} userId={session.userId} />
      <QuantLimitsDesk />
      <QuantPromotionAuditDesk audit={audit} />
    </DeskPage>
  );
}
