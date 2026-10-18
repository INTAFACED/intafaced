import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../../../services/svc-pay/src/payment-service.js';
import { memoryPayoutDestinations } from '../../../services/svc-pay/src/merchant-payout-destination.js';
import { RailRegistry } from '../../../services/svc-pay/src/rails/registry.js';
import { CryptoNativeAdapter } from '../../../services/svc-pay/src/rails/crypto-native.js';
import { MemoryChain } from '../../../services/svc-pay/src/rails/chain-port.js';
import { MetricsProjector } from '../../../services/svc-pay/src/metrics/projector.js';
import { readProjection, listProjectionKeys } from '../../../services/svc-pay/src/metrics/compute.js';
import { Deadline, parseOptions, assertLedgerBalanced, assertOutbound, type Options, type Outbound } from './safety.js';
import { assertProjection, recompute, type Sources } from './oracle.js';
import { SimulationDatabase } from './database.js';
import { syntheticPayoutAddress } from './fixtures.js';

/** origin/main this manifest was read against. */
export const BASE = '6e618f75a8ffd2ef7d254f72bbecbf29c559331f';
/**
 * What this simulator does not assert. Status is the service on `BASE`, not a pass.
 * W1 and W5 guards are real. W6's conversion service is on main; its pay seam slot still returns nothing.
 * W9's screening slot still returns nothing.
 */
export const NOT_BUILT = [
  {
    id: 'W1',
    status: 'built-not-asserted',
    checks: 'Merchant caps exist behind PAY_MERCHANT_CONTROLS (default off). This simulator does not assert them.',
  },
  {
    id: 'W5',
    status: 'built-not-asserted',
    checks: 'Halt guards exist. Automatic storm trip is not in that guard. This simulator does not assert exposure.',
  },
  {
    id: 'W6',
    status: 'built-not-asserted',
    checks: 'Conversion service is on main. createW6ConversionGuards still returns nothing. This simulator does not place venue orders.',
  },
  {
    id: 'W9',
    status: 'not-built-at-base',
    checks: 'Screening provider slot still returns nothing on this main. Not asserted.',
  },
] as const;

/** Archetypes are scenario metadata only. All rates and amounts below are TEST VALUES. */
const SCENARIOS = [
  { archetype: 'PSP', amount: '100.25', refund: '10.01' },
  { archetype: 'broker', amount: '80', refund: '5' },
  { archetype: 'gaming', amount: '40', refund: '1' },
] as const;
/**
 * SANDBOX-ONLY webhook signing secret for the in-memory chain. Never a real key.
 * Taken from PAY_SIM_WEBHOOK_SECRET when set, otherwise a random value per run, so no
 * secret is committed to the repository.
 */
function sandboxWebhookSecret(): string {
  return process.env.PAY_SIM_WEBHOOK_SECRET || `sandbox-pay-sim-${randomBytes(24).toString('hex')}`;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`pay-sim assertion failed: ${message}`);
}

async function expectFailure(effect: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await effect();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === expected || e.message?.includes(expected)) return;
    throw error;
  }
  throw new Error(`pay-sim fault injection did not fail: ${expected}`);
}

async function sources(sql: Sql): Promise<Sources> {
  return {
    payments: await sql<Sources['payments']>`SELECT id, merchant_id, currency, status::text, created_at FROM pay.payments`,
    events: await sql<
      Sources['events']
    >`SELECT payment_id, event, payload, ts FROM pay.payment_events WHERE event IN ('captured', 'refunded') ORDER BY seq`,
    settlements: await sql<
      Sources['settlements']
    >`SELECT merchant_id, asset_id, gross::text, fees::text, net::text, status::text, created_at FROM pay.settlements`,
    sessions: await sql<Sources['sessions']>`SELECT payment_id, link_id FROM pay.checkout_sessions`,
  };
}

/** Runs real svc-pay paths against an isolated PostgreSQL database and reference adapters.
 * SQL connect/statement/lock waits are bounded. Deadline closes active SQL clients,
 * and finally drops only this run's database (never sweeps another run).
 */
export async function runSimulation(input: Options, signal?: AbortSignal) {
  const options = parseOptions(['--iterations', String(input.iterations), '--timeout-ms', String(input.timeoutMs)], {
    APP_ENV: process.env.APP_ENV,
    TEST_DATABASE_URL: input.databaseUrl,
  });
  const database = new SimulationDatabase(options.databaseUrl);
  const deadline = new Deadline(options.timeoutMs, () => database.close());
  const cancel = () => deadline.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const step = <T>(effect: () => Promise<T>) => deadline.step(effect);
  const ledger = new MemoryLedger();
  const chain = new MemoryChain();
  const crypto = new CryptoNativeAdapter({ chain, secret: sandboxWebhookSecret(), minConfirmations: 6, toleranceSeconds: 300 });
  const faults = { railDown: 0, duplicateEvents: 0, duplicateRefunds: 0, duplicatePayouts: 0, databaseAfterSend: 0 };
  const expected: Outbound[] = [];
  const merchants: Array<{ archetype: string; label: string; id: string }> = [];
  const checkBook = () => {
    assertLedgerBalanced(ledger.journal());
    requireCondition(ledger.reconcile().ok, 'reference ledger reconciliation');
    requireCondition(ledger.verifyChain().ok, 'reference ledger hash chain');
  };
  try {
    const sql = await step(() => database.open());
    const drizzle = new URL('../../../services/svc-pay/drizzle/', import.meta.url);
    for (const file of readdirSync(drizzle)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort()) {
      await step(() => sql.unsafe(readFileSync(new URL(file, drizzle), 'utf8')));
    }
    const destinations = memoryPayoutDestinations();
    const pay = new PayService(sql, ledger, new RailRegistry([crypto]), { payoutDestinations: destinations });
    const projector = new MetricsProjector(sql);
    for (const scenario of SCENARIOS) {
      const merchant = await step(() => pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } }));
      merchants.push({ archetype: scenario.archetype, label: `${scenario.archetype} — TEST DATA`, id: merchant.id });
    }

    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      for (let index = 0; index < SCENARIOS.length; index += 1) {
        const scenario = SCENARIOS[index]!;
        const merchant = merchants[index]!;
        const assetId = (iteration + index) % 2 === 0 ? 'USDT' : 'BTC';
        const payment = await step(() =>
          pay.createPayment({ merchantId: merchant.id, amount: amt(scenario.amount), assetId, method: 'crypto', railAdapter: crypto.id }),
        );
        const address = await step(() => chain.acceptanceAddress(payment.id, assetId));
        const payer = `TEST-DATA-payer-${payment.id}`;
        deadline.check();
        chain.credit({ address, assetId, amount: amt(scenario.amount), from: payer, confirmations: 12 });
        await step(() => pay.authorize(payment.id));
        await step(() => pay.capture(payment.id));
        checkBook();

        const event = crypto.signWebhook({
          id: `TEST-DATA-event-${payment.id}`,
          type: 'captured',
          ref: address,
          amount: scenario.amount,
          assetId,
        });
        await step(() => pay.handleWebhook(crypto.id, event));
        for (let duplicate = 0; duplicate < 2; duplicate += 1) {
          requireCondition((await step(() => pay.handleWebhook(crypto.id, event))).duplicate, 'replayed webhook must be duplicate');
          faults.duplicateEvents += 1;
        }
        const refundId = `TEST-DATA-refund-${payment.id}`;
        await step(() => pay.refund(payment.id, amt(scenario.refund), { refundId }));
        expected.push({ idempotencyKey: `pay.refund:${address}:${refundId}`, to: payer, assetId, amount: amt(scenario.refund) });
        await step(() => pay.refund(payment.id, amt(scenario.refund), { refundId }));
        faults.duplicateRefunds += 1;
        checkBook();
        assertOutbound(chain.outboundTransfers(), expected);

        const settlement = await step(() =>
          pay.settleWindow({
            merchantId: merchant.id,
            window: `TEST-DATA-${iteration}-${index}`,
            assetId,
            from: new Date(Date.now() - 86_400_000),
            to: new Date(Date.now() + 86_400_000),
          }),
        );
        requireCondition(
          settlement.net === amt(scenario.amount) - amt(scenario.refund),
          'payout equals actual captured less refunded TEST VALUES',
        );
        const destination = syntheticPayoutAddress(merchant.id);
        await destinations.seedVerified({ merchantId: merchant.id, railId: crypto.id, kind: 'crypto', ref: destination });
        const request = { settlementId: settlement.id, railId: crypto.id };
        const outboundBefore = chain.outboundTransfers().length;
        for (let failure = 0; failure < 3; failure += 1) {
          deadline.check();
          chain.failNextBroadcast(new Error('TEST DATA — injected rail down'));
          await step(() => expectFailure(() => pay.payoutSettlement(request), 'pay.rail_outcome_unknown'));
          faults.railDown += 1;
          requireCondition(chain.outboundTransfers().length === outboundBefore, 'rail down must not send');
          checkBook();
        }

        // Actual PostgreSQL failure after external send, BEFORE the durable rail outcome.
        await step(() =>
          sql.unsafe(`CREATE FUNCTION pay.sim_fail_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.kind = 'rail_accepted' THEN RAISE EXCEPTION 'TEST_DATA_DB_AFTER_SEND'; END IF; RETURN NEW; END; $$;
          CREATE TRIGGER sim_fail_outcome BEFORE INSERT ON pay.payout_outcomes FOR EACH ROW EXECUTE FUNCTION pay.sim_fail_outcome();`),
        );
        try {
          await step(() => expectFailure(() => pay.payoutSettlement(request), 'TEST_DATA_DB_AFTER_SEND'));
          faults.databaseAfterSend += 1;
          expected.push({ idempotencyKey: `pay.payout:${settlement.id}`, to: destination, assetId, amount: settlement.net });
          assertOutbound(chain.outboundTransfers(), expected);
          requireCondition(
            (
              await step(
                () =>
                  sql`SELECT id FROM pay.payout_outcomes WHERE kind = 'rail_accepted' AND admission_id IN (SELECT id FROM pay.payout_admissions WHERE settlement_id = ${settlement.id})`,
              )
            ).length === 0,
            'DB failure really precedes durable outcome',
          );
          requireCondition(
            (await step(() => pay.getSettlement(settlement.id))).status === 'posted',
            'failed outcome write must leave payout recoverable',
          );
          checkBook();
        } finally {
          // Cleanup runs even when the budget expires. A closed client is harmless:
          // the enclosing finally destroys this run's entire isolated database.
          await sql.unsafe(
            'DROP TRIGGER IF EXISTS sim_fail_outcome ON pay.payout_outcomes; DROP FUNCTION IF EXISTS pay.sim_fail_outcome();',
          );
        }
        requireCondition((await step(() => pay.payoutSettlement(request))).status === 'paid_out', 'recovered payout finishes');
        requireCondition((await step(() => pay.payoutSettlement(request))).status === 'paid_out', 'duplicate payout finishes');
        faults.duplicatePayouts += 1;
        assertOutbound(chain.outboundTransfers(), expected);
        checkBook();
      }
      const drained = await step(() => projector.drain());
      requireCondition(drained.remaining === 0 && drained.failed.length === 0, 'metrics fully drained');
      const source = await step(() => sources(sql));
      const keys = await step(() => listProjectionKeys(sql));
      assertProjection(recompute(source), await step(() => readProjection(sql, keys)));
    }
    const rebuilt = await step(() => projector.rebuild({ clear: true }));
    requireCondition(rebuilt.remaining === 0 && rebuilt.failed.length === 0, 'metrics rebuild fully drained');
    assertProjection(recompute(await step(() => sources(sql))), await step(async () => readProjection(sql, await listProjectionKeys(sql))));
    checkBook();
    assertOutbound(chain.outboundTransfers(), expected);
    return {
      label: 'TEST DATA — no real money',
      base: BASE,
      infrastructure: 'isolated PostgreSQL; MemoryLedger; MemoryChain; actual CryptoNativeAdapter/PayService',
      iterationsCompleted: options.iterations,
      merchants,
      payments: options.iterations * SCENARIOS.length,
      outboundTransfers: chain.outboundTransfers().length,
      faults,
      checks: {
        ledgerPerAsset: 'verified',
        ledgerChain: 'verified',
        metricsIndependent: 'verified',
        metricsRebuild: 'verified',
        outboundExactlyOnce: 'verified',
      },
      notBuilt: NOT_BUILT,
    };
  } catch (error) {
    deadline.check();
    throw error;
  } finally {
    try {
      await database.close();
      deadline.check();
    } finally {
      signal?.removeEventListener('abort', cancel);
      deadline.dispose();
    }
  }
}
