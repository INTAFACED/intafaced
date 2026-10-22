import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  payReceivedHoldAccount,
  recipes,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { ReceivedHoldService, memoryReceivedHoldStore, type ReceivedHoldRow } from './received-holds.js';

const RECIPIENT = '11111111-1111-4111-8111-111111111111';
const PAYER = '22222222-2222-4222-8222-222222222222';
const A = 'USDT';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function setup(state: ReceivedHoldRow['state'] = 'pending', amount = '300') {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: RECIPIENT, assetId: A, amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-1' }));
  const store = memoryReceivedHoldStore([
    { holdId: 'h1', recipientUserId: RECIPIENT, payerUserId: PAYER, assetId: A, amount: amt(amount), state },
  ]);
  return { ledger, store, holds: new ReceivedHoldService(ledger, store) };
}

describe('holds on received funds: the svc-bank caller', () => {
  it('places the stored amount and marks the row held', async () => {
    const { ledger, store, holds } = await setup();
    await holds.place('h1');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, A, 'h1'))).toBe('300');
    expect(store.rows[0]!.state).toBe('held');
  });

  it('releases exactly the stored amount; the API takes no amount at all', async () => {
    const { ledger, store, holds } = await setup();
    await holds.place('h1');
    // The only input is the hold id: release cannot be asked for part of a hold.
    expect(holds.release.length).toBe(1);
    const tx = await holds.release('h1');
    expect(tx.entries.every((e) => e.amount === amt('300'))).toBe(true);
    expect(await bal(ledger, userAvailable(RECIPIENT, A))).toBe('1000');
    expect(store.rows[0]!.state).toBe('released');
  });

  it('returns exactly the stored amount to the stored payer', async () => {
    const { ledger, store, holds } = await setup();
    await holds.place('h1');
    expect(holds.return.length).toBe(1);
    await holds.return('h1');
    expect(await bal(ledger, userAvailable(PAYER, A))).toBe('300');
    expect(store.rows[0]!.state).toBe('returned');
  });

  it('one outcome per hold: release then return, and return then release, are refused', async () => {
    const one = await setup();
    await one.holds.place('h1');
    await one.holds.release('h1');
    await expect(one.holds.return('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    expect(await bal(one.ledger, userAvailable(PAYER, A))).toBe('0');

    const two = await setup();
    await two.holds.place('h1');
    await two.holds.return('h1');
    await expect(two.holds.release('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
  });

  it('refuses a hold that was never placed, a second place, and an unknown or blank id', async () => {
    const { holds } = await setup();
    await expect(holds.release('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    await holds.place('h1');
    await expect(holds.place('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    await expect(holds.release('nope')).rejects.toMatchObject({ code: 'bank.received_hold_not_found' });
    await expect(holds.release(' ')).rejects.toMatchObject({ code: 'bank.received_hold_not_found' });
  });

  it('fails closed before the ledger grant: typed refusal, nothing posted, row unchanged', async () => {
    const { ledger, store } = await setup();
    const ungranted: LedgerClient = {
      ...ledger,
      post: async () => {
        throw new LedgerError('caller svc-bank may not post payReceivedHold', 'ledger.caller_forbidden');
      },
    } as unknown as LedgerClient;
    const holds = new ReceivedHoldService(ungranted, store);
    await expect(holds.place('h1')).rejects.toMatchObject({ code: 'bank.received_hold_not_granted' });
    expect(store.rows[0]!.state).toBe('pending');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, A, 'h1'))).toBe('0');

    store.rows[0] = { ...store.rows[0]!, state: 'held' };
    await expect(holds.release('h1')).rejects.toMatchObject({ code: 'bank.received_hold_not_granted' });
    await expect(holds.return('h1')).rejects.toMatchObject({ code: 'bank.received_hold_not_granted' });
    expect(store.rows[0]!.state).toBe('held');
  });

  it('passes any other ledger failure through and leaves the row unchanged', async () => {
    const { store } = await setup('pending', '5000');
    const ledger = new MemoryLedger();
    const holds = new ReceivedHoldService(ledger, store);
    await expect(holds.place('h1')).rejects.toBeInstanceOf(LedgerError);
    expect(store.rows[0]!.state).toBe('pending');
  });
});
