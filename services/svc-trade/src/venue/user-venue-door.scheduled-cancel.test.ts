import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type VenueIntent } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError } from './user-venue-door.js';

// J-cex-spot-07 at the door: the dead-man switch is the venue's own scheduled cancel. The door arms it only with a
// timeout the owner published (or 0, which removes it), timed from now, refuses an unpublished one and a blank list
// before anything is prepared, says "not offered" where the venue has none, and a retry of the same key is the same
// stored action with the same time. Against the TEST venue simulator over loopback HTTP. Every figure is TEST.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c7';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-cex-spot-07')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};
const PUBLISHED = [10, 30, 60, 120];
const NOW = Date.UTC(2026, 10, 16, 8, 0, 0);

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('UserVenueDoor: the venue scheduled cancel (J-cex-spot-07)', { timeout: 60_000 }, () => {
  let venue: { server: http.Server; sim: TestVenueSimulator; url: string };
  let store: InMemoryPreparedActionStore;
  const clock = { now: NOW };
  const door = (timeouts: readonly number[] | null) =>
    new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venue.url, timeoutMs: 5000 }),
      appEnv: 'test',
      store,
      stepUp: noStepUp,
      builder: null,
      now: () => new Date(clock.now),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
      slippageCapBps: null,
      scheduledCancelTimeouts: timeouts,
    });
  const account = () => ({ venueId: venue.sim.venue.id, owner, subAccount: null });
  const arm = (timeoutSec: number) => ({ kind: 'schedule_cancel', timeoutSec, time: null }) as VenueIntent;
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      if (error instanceof UserVenueDoorError) return error.code;
      if (error instanceof VenueRefusalError) return error.refusal.code;
      throw error;
    }
    return 'none';
  };

  beforeAll(async () => {
    // The venue's own clock follows the test's, so the time the door signs is ahead of the venue's now.
    venue = await startTestVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      chainId: 84532,
      clock: () => new Date(clock.now),
      scheduledCancelMinLeadMs: 5_000,
    });
    venue.sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:js7-door');
    store = new InMemoryPreparedActionStore();
  });
  afterAll(async () => closeServer(venue.server));

  it('says in its status that the venue has a scheduled cancel, with the published timeouts', async () => {
    expect(await door(PUBLISHED).status()).toMatchObject({ scheduledCancel: { minLeadMs: 5_000, timeoutsSec: PUBLISHED } });
    expect(await door(null).status()).toMatchObject({ scheduledCancel: { minLeadMs: 5_000, timeoutsSec: null } });
  });

  it('arms it with a published timeout, timed from now, and the venue records that time; a retry is the same action', async () => {
    const d = door(PUBLISHED);
    const actionKey = `schedule-cancel:${owner}:arm-1`;
    const prepared = await d.prepare(principal, { owner, signer, intent: arm(30), actionKey });
    expect(prepared.prepared.intent).toEqual({ kind: 'schedule_cancel', timeoutSec: 30, time: new Date(NOW + 30_000).toISOString() });
    clock.now += 2_000;
    const again = await d.prepare(principal, { owner, signer, intent: arm(30), actionKey });
    expect(again.reused).toBe(true);
    expect(again.prepared.digest).toBe(prepared.prepared.digest);
    const sent = await d.submit(principal, actionKey, await sign(prepared.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect((await venue.sim.scheduledCancel(account())).value.cancelsAt).toEqual(new Date(NOW + 30_000));
  });

  it('refuses an unpublished timeout and a blank list before anything is prepared', async () => {
    const actionKey = `schedule-cancel:${owner}:arm-7`;
    expect(await codeOf(door(PUBLISHED).prepare(principal, { owner, signer, intent: arm(7), actionKey }))).toBe(
      'trade.cancel_all_after_rejected',
    );
    expect(await codeOf(door(null).prepare(principal, { owner, signer, intent: arm(10), actionKey }))).toBe('trade.cancel_all_after_unset');
    expect(await codeOf(door([]).prepare(principal, { owner, signer, intent: arm(10), actionKey }))).toBe('trade.cancel_all_after_unset');
    expect(await store.find(USER, actionKey)).toBeNull();
  });

  it('timeout 0 removes it, even with no published list', async () => {
    const d = door(null);
    const actionKey = `schedule-cancel:${owner}:off-1`;
    const prepared = await d.prepare(principal, { owner, signer, intent: arm(0), actionKey });
    expect(prepared.prepared.intent).toEqual({ kind: 'schedule_cancel', timeoutSec: 0, time: null });
    await d.submit(principal, actionKey, await sign(prepared.prepared));
    expect((await venue.sim.scheduledCancel(account())).value.cancelsAt).toBeNull();
  });

  it('where the venue declares none: not offered, before anything is prepared', async () => {
    venue.sim.declareScheduledCancel(null);
    try {
      const d = door(PUBLISHED);
      expect(await d.status()).toMatchObject({ scheduledCancel: null });
      const actionKey = `schedule-cancel:${owner}:none-1`;
      expect(await codeOf(d.prepare(principal, { owner, signer, intent: arm(10), actionKey }))).toBe('not_offered');
      expect(await store.find(USER, actionKey)).toBeNull();
    } finally {
      venue.sim.declareScheduledCancel(5_000);
    }
  });
});
