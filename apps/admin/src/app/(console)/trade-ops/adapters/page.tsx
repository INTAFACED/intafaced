import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { AdaptersRoom } from '@/components/trade-ops/adapters-room';
import { readAdapterStatus } from '@/lib/trade-ops/adapters';

/**
 * FIX and SBE (J-cex-spot-20 #3, SP-order-02): the FIX sessions, the CompID mapping and the SBE consumers from the
 * adapters' own status, read through svc-edge. FIX and SBE are adapters onto matching and the depth tape: neither holds a
 * balance or computes a Greeks value, and nothing here does either.
 */
export const dynamic = 'force-dynamic';

export default async function AdaptersPage() {
  requireModulePage('tradeops');
  const { session, config } = await requireFounderPage();
  const status = await readAdapterStatus({ session, config });
  const halves = status.kind === 'ok' ? [status.data.fix, status.data.sbe] : [];
  const notOk = halves.flatMap((h) => (h.read === 'ok' ? [] : [h]));
  return (
    <DeskPage
      title="FIX and SBE"
      description="The FIX sessions, the CompID to account mapping and the SBE tape consumers, as each adapter reports them. Adapters carry orders and market data only."
      asOf={status.kind === 'ok' ? status.data.asOf : null}
      state={
        status.kind !== 'ok'
          ? status.kind === 'unknown'
            ? 'unknown'
            : 'refused'
          : notOk.length
            ? notOk.some((h) => h.read === 'refused')
              ? 'refused'
              : 'unknown'
            : 'live'
      }
      stateReason={
        status.kind === 'ok' ? notOk.map((h) => h.code).join(', ') || undefined : status.kind === 'unknown' ? status.message : status.code
      }
    >
      {status.kind === 'ok' ? (
        <AdaptersRoom status={status.data} />
      ) : (
        <ReadProblem outcome={status} title="The adapters' status could not be read" />
      )}
    </DeskPage>
  );
}
