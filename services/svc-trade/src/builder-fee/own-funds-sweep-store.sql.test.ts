import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { SqlOwnFundsSweepStore } from './own-funds-sweep-store.js';
import type { OwnFundsSweepRow } from './own-funds-sweep.js';
import { ownFundsSweepSettings } from './wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The own-funds sweep store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const BUILDER = '0x116d8f7751e72306d499dd61ae826e46a726c632';
const prepared = (nonce: string): PreparedVenueAction => ({
  venueId: 'test-venue-sim',
  account: { venueId: 'test-venue-sim', owner: BUILDER, subAccount: null },
  signer: { role: 'owner', address: BUILDER },
  intent: {
    kind: 'withdraw',
    asset: 'USDC',
    amount: parseAmount('8.123456'),
    destination: '0x00000000000000000000000000000000ce510001',
    withdrawalKey: 'k',
  },
  nonce,
  venueClientOrderId: null,
  typedData: { message: { amount: '8.123456' } },
  digest: `0xdigest${nonce}`,
  builderFee: null,
  preparedAt: new Date('2026-11-14T13:00:00.000Z'),
});
const row = (n: number): OwnFundsSweepRow => ({
  key: `own-funds-sweep:test-venue-sim:${n}`,
  venueId: 'test-venue-sim',
  prepared: prepared(String(1000 + n)),
  signature: { digest: `0xdigest${1000 + n}`, signature: '0xsig', signedBy: BUILDER },
  state: 'sent',
  reason: null,
  txHash: null,
  ledgerTxId: null,
});

describe('SqlOwnFundsSweepStore on Postgres (trade.own_funds_sweeps)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps the prepared, signed withdrawal exactly, one open sweep per venue, and a posted one only with its transaction', async () => {
    const store = new SqlOwnFundsSweepStore(db!.sql);
    expect(await store.open('test-venue-sim')).toBeNull();
    expect(await store.count('test-venue-sim')).toBe(0);
    await store.insert(row(1));
    const open = await store.open('test-venue-sim');
    expect(open).toEqual(row(1));
    expect(open!.prepared.intent).toMatchObject({ amount: parseAmount('8.123456') });
    // A second open sweep for the venue is refused by the database itself.
    await expect(store.insert(row(2))).rejects.toThrow();
    // Posted needs its transaction and ledger id.
    await expect(store.update(row(1).key, { state: 'posted' })).rejects.toThrow();
    await store.update(row(1).key, { state: 'held', reason: 'ledger.frozen', txHash: '0xabc' });
    expect(await store.open('test-venue-sim')).toMatchObject({ state: 'held', reason: 'ledger.frozen', txHash: '0xabc' });
    await store.update(row(1).key, { state: 'posted', reason: null, ledgerTxId: 'tx-1' });
    expect(await store.open('test-venue-sim')).toBeNull();
    expect(await store.count('test-venue-sim')).toBe(1);
    await store.insert(row(2));
    expect(await store.count('test-venue-sim')).toBe(2);
  });
});

describe('ownFundsSweepSettings', () => {
  const blank = {
    TRADE_OWN_FUNDS_FLOAT: '',
    TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS: '',
    TRADE_OWN_FUNDS_WALLET: '',
    TRADE_BUILDER_KEY_SEED: '',
  };
  it('reads blank as unset, every one', () => {
    expect(ownFundsSweepSettings(blank)).toEqual({ float: null, intervalMs: null, wallet: null, signer: null });
    expect(ownFundsSweepSettings({ ...blank, TRADE_OWN_FUNDS_FLOAT: '-1', TRADE_OWN_FUNDS_WALLET: 'no-place=0x1' }).float).toBeNull();
  });
  it("reads the stack's TEST values, and the TEST seed signs as the TEST builder address", () => {
    const s = ownFundsSweepSettings({
      TRADE_OWN_FUNDS_FLOAT: '2',
      TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS: '3000',
      TRADE_OWN_FUNDS_WALLET: 'test-chain:rewards=0x00000000000000000000000000000000CE510001',
      TRADE_BUILDER_KEY_SEED: 'intafaced LOCAL TEST builder key seed - public, holds nothing real',
    });
    expect(s).toMatchObject({
      float: parseAmount('2'),
      intervalMs: 3000,
      wallet: { walletId: 'test-chain:rewards', address: '0x00000000000000000000000000000000ce510001' },
    });
    expect(s.signer?.address).toBe(BUILDER);
  });
});
