import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { SeedingRoom } from '@/components/trade-ops/seeding-room';
import { readMarkets } from '@/lib/trade-ops/reads';
import { readSeedConfigs } from '@/lib/trade-ops/seeding-calls';

/**
 * Seeding (J-cex-spot-20 #5, RC-cex-spot-17): the internal book seeding configuration per market, written by an operator
 * and approved by a second one. Once any market has a version here, these are the seed job's whole configuration and the
 * environment's values are not used. Seeded orders rest on the house account and are marked seeded everywhere.
 */
export const dynamic = 'force-dynamic';

export default async function SeedingPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const [markets, configs] = await Promise.all([readMarkets(ctx), readSeedConfigs(ctx)]);
  const failing = markets.kind !== 'ok' ? markets : configs.kind !== 'ok' ? configs : null;
  return (
    <DeskPage
      title="Seeding"
      description="The house book seed per market: spread, step, levels, quantity and mid source. A new version needs a second founder; switching a market off cancels its seed orders."
      asOf={configs.kind === 'ok' ? configs.asOf : null}
      state={failing ? (failing.kind === 'unknown' ? 'unknown' : 'refused') : 'live'}
      stateReason={failing ? (failing.kind === 'unknown' ? failing.message : failing.code) : undefined}
    >
      {markets.kind === 'ok' && configs.kind === 'ok' ? (
        <SeedingRoom
          markets={markets.data.filter((m) => m.kind === 'spot').map((m) => ({ id: m.id, symbol: m.symbol }))}
          configs={configs.data}
        />
      ) : (
        <ReadProblem outcome={failing!} title="The seeding configuration could not be read" />
      )}
    </DeskPage>
  );
}
