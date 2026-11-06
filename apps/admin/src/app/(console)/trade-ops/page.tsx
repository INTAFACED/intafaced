import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { HealthRefresh } from '@/components/trade-ops/health-refresh';
import { HealthRooms } from '@/components/trade-ops/health-rooms';
import { HealthTile } from '@/components/trade-ops/health-tile';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { countMarkets, clockUtc, oldestAsOf, sumTallies } from '@/lib/trade-ops/markets-model';
import { loadMarkets, ORDER_READ_LIMIT } from '@/lib/trade-ops/markets-load';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { readKillSwitchSnapshot } from '@/lib/trade-ops/reads';
import { readMatchingHealth } from '@/lib/trade-ops/matching-edge';
import { readReconcileStatus } from '@/lib/trade-ops/desk-reads';
import { sweepLeftOpen, sweepLine } from '@/lib/trade-ops/order-read';
import { venueLines } from '@/components/trade-ops/venue-metrics';
import Link from 'next/link';

/**
 * Health: is the book safe to trade right now, in one glance. Six tiles, each read on its own and each with its
 * own state. Venue health is read from svc-matching through svc-edge, with each figure the engine gave; the reconcile tile reads
 * svc-trade's last sweep (J-cex-spot-20 #1 #2).
 */
export const dynamic = 'force-dynamic';

type Problem = Exclude<Outcome<unknown>, { kind: 'ok' }>;
const stateOf = (o: Outcome<unknown>): 'live' | 'unknown' | 'refused' => (o.kind === 'ok' ? 'live' : o.kind);
const why = (o: Problem): string => o.message;
const codeOf = (o: Problem): string | undefined => (o.kind === 'refused' ? o.code : undefined);

const at = (o: Outcome<unknown>): string => (o.kind === 'ok' ? clockUtc(o.asOf) : 'not read');

export default async function HealthPage() {
  requireModulePage('tradeops');
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const [kill, bundle, venue, recon] = await Promise.all([
    readKillSwitchSnapshot(),
    loadMarkets(ctx),
    readMatchingHealth(ctx),
    readReconcileStatus(ctx),
  ]);
  const { markets, orders, views } = bundle;

  const reads: Outcome<unknown>[] = [kill, markets, orders, venue, recon];
  const asOf = oldestAsOf(reads.map((r) => (r.kind === 'ok' ? r.asOf : null)));
  const anyRefused = reads.some((r) => r.kind === 'refused');
  const anyUnknown = reads.some((r) => r.kind === 'unknown');
  const state = anyRefused ? 'refused' : anyUnknown ? 'unknown' : 'live';
  const failing = reads.filter((r): r is Problem => r.kind !== 'ok');

  const counts = markets.kind === 'ok' ? countMarkets(views) : null;
  const orderTally = orders.kind === 'ok' ? sumTallies(orders.data) : null;

  return (
    <DeskPage
      title="Health"
      description="Is the book safe to trade right now. Each tile is read on its own and shows when it was read."
      asOf={asOf}
      state={state}
      stateReason={
        failing.length
          ? `${failing.length} of ${reads.length} reads did not come back: ${failing.map((f) => (f.kind === 'refused' ? f.code : 'no answer')).join(', ')}`
          : undefined
      }
      actions={<HealthRefresh />}
    >
      <PageSection title="Tiles">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {kill.kind === 'ok' ? (
            (() => {
              const stopped = kill.data.disabledModules.some((m) => m === 'trade');
              return (
                <HealthTile
                  title="Trading module"
                  state="live"
                  asOf={kill.asOf}
                  value={stopped ? 'Stopped' : 'Open'}
                  lines={[
                    stopped
                      ? `New orders are refused. Reason: ${kill.data.reasons.trade ?? 'not recorded'}`
                      : 'The trade module is accepting orders (kill switch is off).',
                  ]}
                  href="/trade-ops/kill-switch"
                  linkLabel="Open kill switch"
                />
              );
            })()
          ) : (
            <HealthTile
              title="Trading module"
              state={stateOf(kill)}
              value={null}
              reason={why(kill)}
              code={codeOf(kill)}
              href="/trade-ops/kill-switch"
              linkLabel="Open kill switch"
            />
          )}

          {venue.kind === 'ok' ? (
            <HealthTile
              title="Venue / matching"
              state="live"
              asOf={venue.data.asOf}
              value={venue.data.venueHalted ? 'Halted' : 'Running'}
              lines={venueLines(venue.data)}
              href="/trade-ops/kill-switch"
              linkLabel="Open kill switch"
            />
          ) : (
            <HealthTile
              title="Venue / matching"
              state={stateOf(venue)}
              value={null}
              reason={why(venue)}
              code={codeOf(venue)}
              lines={['Whether the venue is halted, how many orders rest and how many journal records exist could not be read.']}
              href="/trade-ops/kill-switch"
              linkLabel="Open kill switch"
            />
          )}

          {markets.kind === 'ok' && counts ? (
            <HealthTile
              title="Markets"
              state="live"
              asOf={markets.asOf}
              value={`${counts.total} markets`}
              lines={
                counts.lifecycleRead === 0
                  ? [
                      `Lifecycle could not be read for any market (${counts.lifecycleProblems.join(', ')}), so record status is shown.`,
                      `${counts.byRecord.active} active · ${counts.byRecord.halted} halted · ${counts.byRecord.pending} pending · ${counts.byRecord.delisted} delisted`,
                    ]
                  : [
                      `${counts.byGroup.open} open · ${counts.byGroup.restricted} restricted · ${counts.byGroup.halted} halted · ${counts.byGroup.ended} ended`,
                      counts.byGroup.unknown + counts.byGroup.not_live > 0
                        ? `${counts.byGroup.not_live} not live · ${counts.byGroup.unknown} unknown (lifecycle: ${counts.lifecycleProblems.join(', ') || 'read'})`
                        : 'Every market lifecycle was read.',
                    ]
              }
              href="/trade-ops/markets"
              linkLabel="Open markets"
            />
          ) : (
            <HealthTile
              title="Markets"
              state={stateOf(markets)}
              value={null}
              reason={markets.kind === 'ok' ? undefined : why(markets)}
              code={markets.kind === 'ok' ? undefined : codeOf(markets)}
              href="/trade-ops/markets"
              linkLabel="Open markets"
            />
          )}

          {orders.kind === 'ok' && orderTally ? (
            <HealthTile
              title="Open orders"
              state="live"
              asOf={orders.asOf}
              value={orderTally.open >= ORDER_READ_LIMIT ? `${orderTally.open}+` : String(orderTally.open)}
              lines={[
                `Seeded ${orderTally.seeded} · Held ${orderTally.held}`,
                orderTally.held > 0 ? 'Held orders keep funds reserved and their outcome is not known.' : 'No order is held for recovery.',
                ...(orderTally.open >= ORDER_READ_LIMIT
                  ? [`Only the first ${ORDER_READ_LIMIT} open orders are read; the real count may be higher.`]
                  : []),
              ]}
              href="/trade-ops/orders"
              linkLabel="Open orders"
            />
          ) : (
            <HealthTile
              title="Open orders"
              state={stateOf(orders)}
              value={null}
              reason={orders.kind === 'ok' ? undefined : why(orders)}
              code={orders.kind === 'ok' ? undefined : codeOf(orders)}
              href="/trade-ops/orders"
              linkLabel="Open orders"
            />
          )}

          {recon.kind === 'ok' ? (
            <HealthTile
              title="Reconcile"
              state="live"
              asOf={recon.asOf}
              value={recon.data.kind === 'swept' ? clockUtc(recon.data.at) : 'No sweep run'}
              lines={
                recon.data.kind === 'swept'
                  ? [
                      <span
                        key="last"
                        data-last-sweep=""
                        data-checked={recon.data.result.checked}
                        data-released={recon.data.result.released}
                      >
                        Last sweep: {sweepLine(recon.data.result)}
                      </span>,
                      ...(sweepLeftOpen(recon.data.result).length
                        ? sweepLeftOpen(recon.data.result).map((line) => (
                            <span key={line} data-sweep-open="" className="text-warn">
                              {line}
                            </span>
                          ))
                        : ['Every order it looked at was settled.']),
                    ]
                  : ['svc-trade has no record of any reconcile sweep. Start one from Orders.']
              }
              href="/trade-ops/orders"
              linkLabel="Open orders"
            />
          ) : (
            <HealthTile
              title="Reconcile"
              state={stateOf(recon)}
              value={null}
              reason={why(recon)}
              code={codeOf(recon)}
              lines={['The last reconcile sweep could not be read.']}
              href="/trade-ops/orders"
              linkLabel="Open orders"
            />
          )}

          <HealthTile
            title="Data freshness"
            state={asOf ? 'live' : 'unknown'}
            asOf={asOf}
            value={asOf ? clockUtc(asOf) : null}
            reason={asOf ? undefined : 'No read came back, so there is no time to show.'}
            lines={[
              'This is the oldest of the reads above (kill switch, markets, open orders, venue, reconcile).',
              `Kill switch ${at(kill)} · Markets ${at(markets)} · Orders ${at(orders)} · Venue ${at(venue)} · Reconcile ${at(recon)}`,
            ]}
            href="/trade-ops"
            linkLabel="Reload this page"
          />
        </div>
      </PageSection>

      <PageSection title="Rooms">
        <HealthRooms />
        <p className="mt-2 text-sm">
          <Link href="/more-ops/venue-economics" className="font-medium underline-offset-2 hover:underline">
            Open venue unit economics
          </Link>{' '}
          <span className="text-xs text-fg-2">What the venue earns from the ledger’s fee postings against what it costs to run.</span>
        </p>
      </PageSection>
    </DeskPage>
  );
}
