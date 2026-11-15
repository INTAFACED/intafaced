import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { QuantHaltDesk } from '@/components/trade-ops/quant-halt-desk';
import { readHaltDesk } from '@/lib/trade-ops/quant-halts-calls';

/** The quant desk (J-algo-dev-11): every live strategy run, halt one or every strategy, and restore, from svc-trade. */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const { session, config } = await requireFounderPage();
  const read = await readHaltDesk({ session, config });
  return (
    <DeskPage
      title="Quant desk"
      description="Every live strategy run with its owner, state and version. Halt one strategy, or every strategy with a second founder; restoring needs a second founder too."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'unknown' ? read.message : read.code}
    >
      <QuantHaltDesk initial={read} userId={session.userId} />
    </DeskPage>
  );
}
