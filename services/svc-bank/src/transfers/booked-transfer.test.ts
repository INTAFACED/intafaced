import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { bookedTransferMatches } from './booked-transfer.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAT = '33333333-3333-4333-8333-333333333333';

async function seeded() {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'seed-1' }));
  const from = userAvailable(ADA, 'USDT');
  const to = userAvailable(BOB, 'USDT');
  const tx = await ledger.post(
    recipes.bankTransfer({ transferId: 'booked-01', occurrence: 0, from, to, amount: amt('10'), kind: 'manual', keySpace: 'own' }),
  );
  return { ledger, from, to, tx };
}

describe('bookedTransferMatches', () => {
  it('accepts the transaction that moved exactly this amount between exactly these accounts', async () => {
    const { ledger, from, to, tx } = await seeded();
    expect(await bookedTransferMatches(ledger, tx, from, to, amt('10'))).toBe(true);
  });

  it('refuses a different amount, a different destination and a different source', async () => {
    const { ledger, from, to, tx } = await seeded();
    expect(await bookedTransferMatches(ledger, tx, from, to, amt('11'))).toBe(false);
    expect(await bookedTransferMatches(ledger, tx, from, userAvailable(CAT, 'USDT'), amt('10'))).toBe(false);
    expect(await bookedTransferMatches(ledger, tx, userAvailable(CAT, 'USDT'), to, amt('10'))).toBe(false);
  });

  it('reads the transaction itself when the receipt carries no entries, and refuses when it cannot', async () => {
    const { ledger, from, to, tx } = await seeded();
    const bare = { id: tx.id, entries: [] };
    expect(await bookedTransferMatches(ledger, bare, from, to, amt('10'))).toBe(true);
    expect(await bookedTransferMatches(ledger, bare, from, to, amt('11'))).toBe(false);
    expect(await bookedTransferMatches(ledger, { id: 'missing-tx', entries: [] }, from, to, amt('10'))).toBe(false);
  });
});
