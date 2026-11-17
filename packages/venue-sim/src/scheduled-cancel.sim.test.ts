import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { venueClientOrderId, type PlaceUserOrderIntent, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-cex-spot-07 at the venue: the venue's own scheduled cancel. Signed with a time, the venue itself cancels every open
// order of that account once at that time, releasing its locks, and nobody else's; a later signature moves the time on,
// and one with no time removes it. A venue that declares none refuses it. Every figure is TEST.

const a = parseAmount;
const BTC = 'BTC-USDC';
const START = Date.UTC(2026, 10, 16, 8, 0, 0);

function world(opts: { scheduledCancelMinLeadMs?: number } = { scheduledCancelMinLeadMs: 5_000 }) {
  const clock = { now: START };
  const sim = new TestVenueSimulator({ clock: () => new Date(clock.now), markets: TEST_VENUE_MARKETS, chainId: 84532, ...opts });
  const trader = (name: string) => {
    const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet scheduled-cancel ${name}`)));
    const owner = key.address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    const run = async (intent: VenueIntent) => {
      const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    };
    sim.deposit(account, 'USDC', a('10000'), `chain:scheduled-cancel:${name}`);
    return { account, run };
  };
  return { sim, clock, me: trader('me'), other: trader('other') };
}

type W = ReturnType<typeof world>;
const buy = (who: string, key: string): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: BTC,
  side: 'buy',
  type: 'limit',
  amount: a('0.002'),
  price: a('20000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${who}:${key}`,
  builderFee: null,
});
const at = (w: W, ms: number) => new Date(w.clock.now + ms).toISOString();
const schedule = (w: W, timeoutSec: number): VenueIntent => ({
  kind: 'schedule_cancel',
  timeoutSec,
  time: timeoutSec === 0 ? null : at(w, timeoutSec * 1000),
});
const status = async (w: W, account: UserVenueAccount, who: string, key: string) =>
  (await w.sim.orderByClientId(account, venueClientOrderId(w.sim.venue.id, `order:${who}:${key}`))).value;
const locked = async (w: W, account: UserVenueAccount) => (await w.sim.balances(account)).value.find((b) => b.asset === 'USDC')!.locked;
const refusalOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return (error as { refusal?: { code: string; detail: string } }).refusal;
  }
  return null;
};

describe('TEST venue simulator: the scheduled cancel (J-cex-spot-07)', () => {
  it('declares it only when started with it, and refuses it and its read where none is declared', async () => {
    expect(world().sim.venue.scheduledCancel).toEqual({ minLeadMs: 5_000 });
    const plain = world({});
    expect(plain.sim.venue.scheduledCancel).toBeUndefined();
    expect(await refusalOf(plain.me.run(schedule(plain, 10)))).toMatchObject({ code: 'not_offered' });
    expect(await refusalOf(plain.sim.scheduledCancel(plain.me.account))).toMatchObject({ code: 'not_offered' });
    plain.sim.declareScheduledCancel(5_000);
    expect(await plain.me.run(schedule(plain, 10))).toMatchObject({ definite: true, accepted: true });
  });

  it('at its time cancels every open order of the account once and releases the locks; another account is untouched', async () => {
    const w = world();
    await w.me.run(buy('me', 'a'));
    await w.me.run(buy('me', 'b'));
    await w.other.run(buy('other', 'x'));
    expect(await locked(w, w.me.account)).not.toBe(ZERO);
    const otherLocked = await locked(w, w.other.account);

    expect(await w.me.run(schedule(w, 10))).toMatchObject({ definite: true, accepted: true });
    expect((await w.sim.scheduledCancel(w.me.account)).value).toEqual({ cancelsAt: new Date(START + 10_000), lastFired: null });

    w.clock.now += 9_999;
    expect(w.sim.runScheduledCancels()).toBe(0);
    expect((await status(w, w.me.account, 'me', 'a'))?.status).toBe('open');

    w.clock.now += 1;
    expect(w.sim.runScheduledCancels()).toBe(2);
    for (const k of ['a', 'b']) {
      expect(await status(w, w.me.account, 'me', k)).toMatchObject({ status: 'canceled', cancelReason: 'scheduled_cancel', locked: ZERO });
    }
    expect(await locked(w, w.me.account)).toBe(ZERO);
    expect((await status(w, w.other.account, 'other', 'x'))?.status).toBe('open');
    expect(await locked(w, w.other.account)).toBe(otherLocked);
    // Once: the schedule is cleared, and a later sweep cancels nothing more.
    expect((await w.sim.scheduledCancel(w.me.account)).value).toEqual({
      cancelsAt: null,
      lastFired: { firedAt: new Date(START + 10_000), canceled: 2 },
    });
    w.clock.now += 60_000;
    await w.me.run(buy('me', 'c'));
    expect(w.sim.runScheduledCancels()).toBe(0);
    expect((await status(w, w.me.account, 'me', 'c'))?.status).toBe('open');
  });

  it('fires on any call to the venue after its time, not only on the sweep', async () => {
    const w = world();
    await w.me.run(buy('me', 'a'));
    await w.me.run(schedule(w, 10));
    w.clock.now += 10_000;
    expect((await w.sim.openOrders(w.me.account)).value).toEqual([]);
  });

  it('a later signature moves the time on; timeout 0 removes it, and the orders stay past the old time', async () => {
    const w = world();
    await w.me.run(buy('me', 'a'));
    await w.me.run(schedule(w, 10));
    w.clock.now += 6_000;
    await w.me.run(schedule(w, 10));
    w.clock.now += 6_000; // past the first time, before the second
    expect(w.sim.runScheduledCancels()).toBe(0);
    expect((await status(w, w.me.account, 'me', 'a'))?.status).toBe('open');
    expect(await w.me.run(schedule(w, 0))).toMatchObject({ accepted: true });
    expect((await w.sim.scheduledCancel(w.me.account)).value.cancelsAt).toBeNull();
    w.clock.now += 60_000;
    expect(w.sim.runScheduledCancels()).toBe(0);
    expect((await status(w, w.me.account, 'me', 'a'))?.status).toBe('open');
  });

  it('refuses a time nearer than its least lead, a removal that names a timeout, and a time that is not one', async () => {
    const w = world();
    expect(await refusalOf(w.me.run({ kind: 'schedule_cancel', timeoutSec: 4, time: at(w, 4_000) }))).toMatchObject({
      code: 'venue_rejected',
      detail: 'a scheduled cancel must be at least 5 seconds ahead; this one is 4',
    });
    expect(await refusalOf(w.me.run({ kind: 'schedule_cancel', timeoutSec: 10, time: null }))).toMatchObject({ code: 'venue_rejected' });
    expect(await refusalOf(w.me.run({ kind: 'schedule_cancel', timeoutSec: 10, time: 'soon' }))).toMatchObject({ code: 'venue_rejected' });
    expect((await w.sim.scheduledCancel(w.me.account)).value.cancelsAt).toBeNull();
  });
});
