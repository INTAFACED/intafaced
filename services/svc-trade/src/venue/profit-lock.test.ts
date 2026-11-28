import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { MaybeKnown } from '@intafaced/venue-contracts';
import { InMemoryProfitLockStore, type ProfitLockOffer } from './profit-lock-store.js';
import {
  ProfitLockError,
  VenueProfitLocks,
  coldWalletOf,
  filledIn,
  profitLockOfferKey,
  shareOf,
  startOfUtcWeek,
  weekAt,
  type ProfitLockNotices,
} from './profit-lock.js';

// J-wallet-26 in svc-trade: the weekly Profit lock on the person's own venue account, on a TEST venue figure set held in
// memory. Nothing is sent to the venue from here and nothing is posted; every figure is TEST. One offer and one message
// per week; a share above what the venue lets the account withdraw is cut to it; a venue read that fails is named and
// makes no offer; a closed offer stays closed; a signed one is read from the door's own record by its key.

const a = parseAmount;
const OWNER = '0x1111111111111111111111111111111111111111';
const COLD = '0x52908400098527886e0f7030069857d2e4169ee7';
const COLD_CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const OURS = '0x00000000000000000000000000000000000000b3';
const VENUE = 'test-venue-sim';
const person = { userId: '00000000-0000-4000-8000-000000000001' } as Principal;

class Notices implements ProfitLockNotices {
  readonly sent: ProfitLockOffer[] = [];
  down = false;
  async publish(o: ProfitLockOffer) {
    if (this.down) throw new Error('TEST bus down');
    this.sent.push(o);
  }
}

describe('venue Profit lock (J-wallet-26)', () => {
  let now: Date;
  let fills: { realisedPnl: Amount | null; filledAt: Date }[];
  let free: Amount;
  let fee: MaybeKnown<Amount>;
  let down: boolean;
  let signed: Map<string, string>;
  let store: InMemoryProfitLockStore;
  let notices: Notices;
  let locks: VenueProfitLocks;

  beforeEach(() => {
    now = new Date('2026-11-25T12:00:00.000Z'); // a Wednesday
    fills = [];
    free = a('5000');
    fee = { known: true, value: a('1') };
    down = false;
    signed = new Map();
    store = new InMemoryProfitLockStore();
    notices = new Notices();
    const read = <T>(value: T) => {
      if (down) throw new Error('TEST venue down');
      return { venueId: VENUE, value, asOf: now };
    };
    const venue = {
      venue: { id: VENUE, displayName: 'TEST venue', proofLevel: 'simulator' },
      fills: async (_acc: unknown, since: Date) => read(fills.filter((f) => f.filledAt.getTime() >= since.getTime())),
      balances: async () => read([{ asset: 'USDC', free, locked: a('0'), total: free }]),
      withdrawalTerms: async () => read({ asset: 'USDC', fee, networkFee: { known: false }, arrivalSeconds: null }),
    };
    locks = new VenueProfitLocks({
      door: { venue: async () => venue as never, account: async (owner: string) => ({ venueId: VENUE, owner, subAccount: null }) } as never,
      store,
      actions: {
        find: async (_u: string, key: string) =>
          signed.has(key) ? ({ signature: { signature: '0x' }, prepared: { nonce: signed.get(key) } } as never) : null,
      },
      notices,
      ourAddresses: [OURS],
      now: () => now,
    });
  });

  const set = (coldWallet = COLD, target = '200', share = '50') => locks.set(person, { owner: OWNER, target, share, coldWallet });
  const close = (pnl: string, at = now) => fills.push({ realisedPnl: a(pnl), filledAt: at });

  it('#1 saves the setting; an INTAFACED address, a mistyped one or the account’s own wallet is refused naming why', async () => {
    await expect(set(OURS)).rejects.toMatchObject({ code: 'trade.profit_lock_address_ours', field: 'Cold wallet' });
    const typo = `${COLD_CHECKSUM.slice(0, -1)}e`;
    await expect(set(typo)).rejects.toMatchObject({ code: 'trade.profit_lock_address_mistyped' });
    await expect(set(OWNER)).rejects.toMatchObject({ code: 'trade.profit_lock_field_invalid' });
    await expect(set('0x1234')).rejects.toBeInstanceOf(ProfitLockError);
    await expect(set(COLD, '0')).rejects.toMatchObject({ field: 'Weekly target' });
    await expect(set(COLD, '200', '101')).rejects.toMatchObject({ field: 'Share to lock' });
    const view = await set(COLD_CHECKSUM);
    expect(view.setting).toMatchObject({ target: '200', share: '50', coldWallet: COLD });
    expect(view.week).toMatchObject({ from: '2026-11-23T00:00:00.000Z', readable: true, profit: '0' });
    expect(view.offer).toBeNull();
  });

  it('#2 one offer and one message per week, under its business key, even when the bus was down once', async () => {
    await set();
    close('150');
    expect((await locks.tick()).offered).toBe(0);
    close('80.123456789');
    notices.down = true;
    expect((await locks.tick()).offered).toBe(1);
    expect(notices.sent).toHaveLength(0);
    notices.down = false;
    await locks.tick();
    close('500');
    await locks.tick();
    expect(notices.sent).toHaveLength(1);
    const [o] = notices.sent;
    expect(o!.offerKey).toBe(
      profitLockOfferKey({ userId: person.userId, venueId: VENUE, owner: OWNER }, new Date('2026-11-23T00:00:00.000Z')),
    );
    expect(o!.profit).toBe(a('230.123456789'));
    expect(o!.amount).toBe(a('115.061728')); // 50%, rounded down to USDC's smallest unit
  });

  it('#3 the withdrawal is filled in with the share, and cut to what the venue lets the account withdraw, saying so', async () => {
    await set();
    close('300');
    let view = await locks.get(person, OWNER);
    expect(view.offer).toMatchObject({ state: 'ready', amount: '150', coldWallet: COLD });
    expect(view.withdrawal).toMatchObject({
      amount: '150',
      cut: false,
      free: '5000',
      withdrawable: '4999',
      fee: { known: true, value: '1' },
    });
    free = a('101');
    view = await locks.get(person, OWNER);
    expect(view.withdrawal).toMatchObject({ amount: '100', cut: true, withdrawable: '100' });
    expect(filledIn(a('5'), a('0.5'), { known: true, value: a('1') })).toEqual({ amount: 0n, cut: true, withdrawable: 0n });
  });

  it('#4 a signed withdrawal is read from the door’s record by the offer’s key: the offer is signed and offers nothing more', async () => {
    await set();
    close('300');
    const { offer } = await locks.get(person, OWNER);
    signed.set(offer!.withdrawalKey, '42');
    const view = await locks.get(person, OWNER);
    expect(view.offer).toMatchObject({ state: 'signed', nonce: '42' });
    expect(view.withdrawal).toBeNull();
    await expect(locks.decline(person, OWNER, offer!.offerKey)).rejects.toMatchObject({ code: 'trade.profit_lock_no_offer' });
  });

  it('#5 a week later (TEST clock) the target passes again, the offer is closed, and nothing comes back that week', async () => {
    const lock = await set();
    close('300', new Date(now.getTime() - 1000));
    await locks.tick();
    store.age(lock.lockId!, 7 * 24 * 60 * 60 * 1000, now);
    now = new Date(now.getTime() + 60_000);
    let view = await locks.get(person, OWNER);
    expect(view.week.from).toBe(new Date(now.getTime() - 60_000).toISOString());
    expect(view.week.profit).toBe('0');
    expect(view.offer).toBeNull();
    close('250');
    view = await locks.get(person, OWNER);
    expect(view.offer).toMatchObject({ state: 'ready', profit: '250', amount: '125' });
    view = await locks.decline(person, OWNER, view.offer!.offerKey);
    expect(view.offer?.state).toBe('declined');
    expect(view.withdrawal).toBeNull();
    close('1000');
    await locks.tick();
    expect((await locks.get(person, OWNER)).offer?.state).toBe('declined');
    await locks.publishPending();
    expect(notices.sent).toHaveLength(2);
  });

  it('#6 a venue that can’t be read is named with the last time it was read, never counted as no profit; no offer is made', async () => {
    await set();
    const readAt = now;
    now = new Date(now.getTime() + 60_000);
    down = true;
    close('900');
    const view = await locks.get(person, OWNER);
    expect(view.week).toMatchObject({ readable: false, profit: null, lastReadAt: readAt.toISOString() });
    expect(view.offer).toBeNull();
    await locks.tick();
    expect(notices.sent).toHaveLength(0);
  });

  it('weeks: Monday 00:00 UTC; a lock rolls once its seven days are up', () => {
    expect(startOfUtcWeek(new Date('2026-11-29T23:59:59Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(startOfUtcWeek(new Date('2026-11-30T00:00:00Z')).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    const lock = { weekFrom: new Date('2026-11-23T00:00:00Z'), testAgedAt: null };
    expect(weekAt(lock, new Date('2026-12-02T10:00:00Z')).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(shareOf(a('0.000001'), a('50'))).toBe(0n);
    expect(coldWalletOf(COLD_CHECKSUM, OWNER, [])).toBe(COLD);
  });
});
