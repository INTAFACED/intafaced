import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createFixtureScreeningProvider, type ScreeningOutcome } from '@intafaced/screening';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from '../payment-service.js';
import { MerchantPayoutDestinationStore } from '../merchant-payout-destination.js';
import { MemoryChain } from '../rails/chain-port.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { RailRegistry } from '../rails/registry.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { composeGuards } from '../seams/guards.js';
import { createW9ScreeningGuards } from '../seams/slots/w9-screening.js';
import { PayScreeningService } from './service.js';

// PG-hard: absence of a DB is a failed suite; these tests never silently skip.
const drizzle = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const USER = '11111111-1111-4111-8111-111111111111';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };
const PARTY = { name: 'TEST DATA merchant', country: 'AA', registration: 'TEST-REG', identityKycTier: 'full' as const };

describe('W9 screening on real payout paths, durable review and recovery', () => {
  let db: TestDatabase | undefined;
  let stop = async () => undefined;
  let probe: postgres.Sql | undefined;
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let adapter: CryptoNativeAdapter;
  let outcome: ScreeningOutcome;
  let merchantId: string;

  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) {
      const container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('intafaced_screening_test')
        .withUsername('intafaced')
        .withPassword('intafaced')
        .start();
      url = container.getConnectionUri();
      stop = async () => {
        await container.stop();
      };
    }
    db = await createTestDatabase({ service: 'pay', url, migrations });
    probe = postgres(db.url, { max: 1 });
  }, 120_000);
  afterAll(async () => {
    await probe?.end();
    await db?.drop();
    await stop();
  }, 30_000);
  beforeEach(async () => {
    const sql = db!.sql;
    await truncatePayForTest(
      sql,
      'pay',
      'TRUNCATE pay.checkout_sessions,pay.payment_links,pay.settlements,pay.payment_events,pay.payments,pay.payment_profiles,pay.merchants RESTART IDENTITY CASCADE',
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    outcome = 'pass';
    adapter = new CryptoNativeAdapter({
      chain,
      secret: 'screening-test-secret-at-least-32-characters',
      minConfirmations: 6,
      toleranceSeconds: 300,
    });
    const pay = new PayService(sql, ledger, new RailRegistry([adapter]));
    merchantId = (await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } })).id;
    await sql`UPDATE pay.merchants SET kyb_ref='TEST-DOSSIER' WHERE id=${merchantId}`;
  });

  function screening() {
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [
        {
          reference: { merchantId, kybRef: 'TEST-DOSSIER' },
          party: PARTY,
          partyOutcome: 'pass',
          wallets: [{ address: DEST.ref, chain: 'eip155:31337', outcome: 'pass' }],
        },
      ],
    });
    return new PayScreeningService({
      sql: db!.sql,
      provider: { ...provider, screenWallet: async () => outcome },
      env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off', PAY_CRYPTO_CHAIN_ID: '31337' },
    });
  }
  function service(control = screening()) {
    return new PayService(db!.sql, ledger, new RailRegistry([adapter]), {
      screening: control,
      payoutDestinations: new MerchantPayoutDestinationStore(db!.sql, control),
      guards: composeGuards(createW9ScreeningGuards({ sql: db!.sql, screening: control })),
    });
  }
  async function settlement(pay: PayService) {
    const payment = await pay.createPayment({
      merchantId,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(payment.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: parseAmount('10'), from: 'TEST DATA buyer', confirmations: 12 });
    await pay.authorize(payment.id);
    await pay.capture(payment.id);
    return pay.settleWindow({
      merchantId,
      assetId: 'USDT',
      window: 'TEST-DATA-window',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
  }

  it('first offered destination review survives admission rollback, and passes only after provider pass', async () => {
    const control = screening(),
      pay = service(control),
      window = await settlement(pay);
    const input = { settlementId: window.id, railId: 'crypto-native', destination: DEST };
    outcome = 'review';
    await expect(pay.payoutSettlement(input)).rejects.toMatchObject({ code: 'pay.guard_screening_review' });
    await expect(pay.payoutSettlement(input)).rejects.toMatchObject({ code: 'pay.guard_screening_review' });
    expect(await control.listReviews({ limit: 10 })).toMatchObject([{ settlementId: window.id, attempt: 0, fixture: true }]);
    expect(await db!.sql`SELECT 1 FROM pay.payout_admissions`).toHaveLength(0);
    expect(await ledger.getTxByKey(`withdraw.hold:${window.id}:0`)).toBeNull();
    expect(chain.outboundTransfers()).toHaveLength(0);
    outcome = 'pass';
    expect((await pay.payoutSettlement(input)).status).toBe('paid_out');
    expect(await control.listReviews({ limit: 10 })).toEqual([]);
    expect(chain.outboundTransfers()).toHaveLength(1);
  });

  it('reopens review after pass before hold, deduplicates retries and keeps unavailable refused', async () => {
    const control = screening(),
      pay = service(control),
      window = await settlement(pay);
    const ctx = {
      sql: db!.sql,
      settlementId: window.id,
      attempt: 0,
      merchantId,
      railId: 'crypto-native',
      destination: DEST,
      assetId: 'USDT',
      amount: window.net,
      replay: { kind: 'fresh' as const },
    };
    outcome = 'review';
    await expect(control.beforePayoutExecute(ctx)).rejects.toMatchObject({ code: 'pay.guard_screening_review' });
    outcome = 'pass';
    await control.beforePayoutExecute(ctx);
    expect(await control.listReviews({ limit: 10 })).toEqual([]);
    outcome = 'review';
    await expect(control.beforePayoutExecute(ctx)).rejects.toMatchObject({ code: 'pay.guard_screening_review' });
    expect(await control.listReviews({ limit: 10 })).toHaveLength(1);
    outcome = 'unavailable';
    await expect(pay.payoutSettlement({ settlementId: window.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
    });
    expect(await ledger.getTxByKey(`withdraw.hold:${window.id}:0`)).toBeNull();
    expect(chain.outboundTransfers()).toHaveLength(0);
  });

  it('held payout recovery completes when provider becomes unavailable, with one rail transfer', async () => {
    const pay = service(),
      window = await settlement(pay);
    const original = adapter.payout.bind(adapter);
    let disconnect = true;
    adapter.payout = async (instruction) => {
      if (disconnect) {
        disconnect = false;
        throw new Error('TEST DATA rail disconnect after hold');
      }
      return original(instruction);
    };
    const input = { settlementId: window.id, railId: 'crypto-native', destination: DEST };
    await expect(pay.payoutSettlement(input)).rejects.toThrow('TEST DATA rail disconnect after hold');
    expect(await ledger.getTxByKey(`withdraw.hold:${window.id}:0`)).not.toBeNull();
    outcome = 'unavailable';
    expect((await pay.payoutSettlement(input)).status).toBe('paid_out');
    expect((await pay.payoutSettlement(input)).status).toBe('paid_out');
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('screening never reacquires an earlier merchant lock after the settlement row is locked', async () => {
    const control = screening(),
      pay = service(control),
      window = await settlement(pay);
    // A second transaction owns the earlier merchant row. An accidental W9
    // FOR SHARE/UPDATE would fail under lock_timeout while holding settlement.
    await probe!.begin(async (earlier) => {
      await earlier`SELECT id FROM pay.merchants WHERE id=${merchantId} FOR UPDATE`;
      await db!.sql.begin(async (later) => {
        await later`SET LOCAL lock_timeout='100ms'`;
        await later`SELECT id FROM pay.settlements WHERE id=${window.id} FOR UPDATE`;
        await expect(
          control.beforeDestinationPersist({ merchantId, railId: 'crypto-native', ...DEST }, later as unknown as postgres.Sql),
        ).resolves.toBeUndefined();
      });
    });
  });
});
