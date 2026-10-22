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

  it('a release and a return racing on one hold: exactly one claims and posts, the other is refused before posting', async () => {
    const { ledger, store, holds } = await setup();
    await holds.place('h1');
    const results = await Promise.allSettled([holds.release('h1'), holds.return('h1')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'bank.received_hold_state' });
    const released = store.rows[0]!.state === 'released';
    expect(['released', 'returned']).toContain(store.rows[0]!.state);
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, A, 'h1'))).toBe('0');
    expect(await bal(ledger, userAvailable(PAYER, A))).toBe(released ? '0' : '300');
    expect(await bal(ledger, userAvailable(RECIPIENT, A))).toBe(released ? '1000' : '700');
  });

  it('a crash after the release post: the return is refused, and a release retry finishes without a second post', async () => {
    const { ledger, store } = await setup();
    await new ReceivedHoldService(ledger, store).place('h1');
    // The ledger posts, then the process dies before the state write.
    let crashed = false;
    const crashing = {
      ...ledger,
      post: async (req: Parameters<LedgerClient['post']>[0]) => {
        await ledger.post(req);
        crashed = true;
        throw new Error('process died after the post');
      },
    } as unknown as LedgerClient;
    await expect(new ReceivedHoldService(crashing, store).release('h1')).rejects.toThrow('process died');
    expect(crashed).toBe(true);
    expect(store.rows[0]!.state).toBe('releasing');

    const holds = new ReceivedHoldService(ledger, store);
    await expect(holds.return('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    expect(await bal(ledger, userAvailable(PAYER, A))).toBe('0');
    await holds.release('h1');
    expect(store.rows[0]!.state).toBe('released');
    expect(await bal(ledger, userAvailable(RECIPIENT, A))).toBe('1000');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, A, 'h1'))).toBe('0');
  });

  it('a lost state move is refused: a claim the store does not grant never posts', async () => {
    const { ledger, store } = await setup();
    await new ReceivedHoldService(ledger, store).place('h1');
    let posts = 0;
    const counting = {
      ...ledger,
      post: async (r: Parameters<LedgerClient['post']>[0]) => (posts++, ledger.post(r)),
    } as unknown as LedgerClient;
    const losing = { ...store, setState: async () => false };
    const holds = new ReceivedHoldService(counting, losing);
    await expect(holds.release('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    await expect(holds.return('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    expect(posts).toBe(0);
  });

  it('a settle write that is lost after the post is refused, not reported as done', async () => {
    const { ledger, store } = await setup();
    let calls = 0;
    const flaky = {
      ...store,
      setState: async (id: string, from: ReceivedHoldRow['state'], to: ReceivedHoldRow['state']) =>
        ++calls === 2 ? false : store.setState(id, from, to),
    };
    await expect(new ReceivedHoldService(ledger, flaky).place('h1')).rejects.toMatchObject({ code: 'bank.received_hold_state' });
    expect(store.rows[0]!.state).toBe('placing');
  });
});
