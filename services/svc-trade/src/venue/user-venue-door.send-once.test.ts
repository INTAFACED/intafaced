import http from 'node:http';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';

// A signed action goes to the venue once. A definite answer already recorded is returned without calling the
// venue; an answer that was not definite is read back before anything is sent again; a definite accept is never
// replaced. Against the TEST venue simulator over loopback HTTP, wrapped so the wire can be counted and made to act as
// Hyperliquid does once it has pruned a nonce ("Invalid nonce: nonce too low", which it maps to `nonce_rejected`).

const a = parseAmount;
const USER = '11111111-1111-4111-8111-11111111184a';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-33333333184a',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade #9184 send once')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction): Promise<VenueSignature> {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = { require: async () => ({ stepUpEventId: 'unused', consumedAt: null, replayed: false }) };
const buy = (): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.01'),
    price: a('30000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    builderFee: null,
  }) as PlaceUserOrderIntent;

/**
 * How the venue answers the next call. `ok`: as it does. `late`: it takes the order and the answer is lost. `lost`: the
 * request never reaches it. `down`: unreachable, read included. `stale`: it has pruned the nonces it saw, so bytes it
 * already took are answered "nonce too low".
 */
type Mode = 'ok' | 'late' | 'lost' | 'down' | 'stale';

describe('UserVenueDoor sends a signed action once', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  let mode: Mode = 'ok';
  /** Every signed action that reached the venue, by nonce. */
  const wire: string[] = [];

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:9184');
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const onVenue = async (cloid: string) =>
    (await sim.openOrders({ venueId: sim.venue.id, owner, subAccount: null })).value.filter((o) => o.venueClientOrderId === cloid).length;

  const down = (venueId: string) => new VenueRefusalError({ venueId, code: 'venue_down', detail: 'TEST: the venue is unreachable' });

  async function counted(): Promise<UserVenue> {
    const v = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
    const submit = async (prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> => {
      if (mode === 'down') throw down(prepared.venueId);
      if (mode === 'lost') return { definite: false, reason: 'timeout' };
      if (mode === 'stale' && wire.includes(prepared.nonce)) {
        wire.push(prepared.nonce);
        return {
          definite: true,
          accepted: false,
          refusal: { venueId: prepared.venueId, code: 'nonce_rejected', detail: 'Invalid nonce: nonce too low' },
          asOf: new Date(),
        };
      }
      wire.push(prepared.nonce);
      const answer = await v.submit(prepared, signature);
      return mode === 'late' ? { definite: false, reason: 'timeout' } : answer;
    };
    const orderByClientId: UserVenue['orderByClientId'] = async (account, cloid) => {
      if (mode === 'down') throw down(account.venueId);
      return v.orderByClientId(account, cloid);
    };
    return new Proxy(v, {
      get(target, prop, receiver) {
        if (prop === 'submit') return submit;
        if (prop === 'orderByClientId') return orderByClientId;
        const x = Reflect.get(target, prop, receiver);
        return typeof x === 'function' ? x.bind(target) : x;
      },
    }) as UserVenue;
  }

  /** A door over `store`; a new one over the same store is a restart. `plant` re-sends on a replay, as main did. */
  function door(store: InMemoryPreparedActionStore, plant = false): UserVenueDoor {
    const d = new UserVenueDoor({
      connect: () => counted() as never,
      appEnv: 'test',
      store,
      stepUp: noStepUp,
      builder: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
      ordersPageMax: 50,
      slippageCapBps: null,
    });
    if (!plant) return d;
    const submit = d.submit.bind(d);
    d.submit = async (p, k, s, c) => {
      const answer = await submit(p, k, s, c);
      if (answer.replayed) {
        const row = (await store.find(p.userId, k))!;
        await (await d.venue()).submit(row.prepared, row.signature as VenueSignature);
      }
      return answer;
    };
    return d;
  }

  it('the issue case: after a definite accept the venue answers "nonce too low"; a re-submit sends nothing and keeps the accept', async () => {
    mode = 'ok';
    const store = new InMemoryPreparedActionStore();
    const d = door(store);
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: 'bot-9184:order:case' });
    const signature = await sign(prepared.prepared);
    const first = await d.submit(principal, prepared.actionKey, signature);
    expect(first.outcome).toMatchObject({ definite: true, accepted: true });
    const sent = wire.filter((n) => n === prepared.prepared.nonce).length;
    expect(sent).toBe(1);
    mode = 'stale';
    try {
      const again = await d.submit(principal, prepared.actionKey, signature);
      expect(wire.filter((n) => n === prepared.prepared.nonce)).toHaveLength(1);
      expect(again).toMatchObject({ replayed: true, readBack: null });
      expect(again.outcome).toEqual(first.outcome);
      expect((await store.find(USER, prepared.actionKey))?.lastOutcome).toMatchObject({ definite: true, accepted: true });
    } finally {
      mode = 'ok';
    }
    expect(await onVenue(prepared.prepared.venueClientOrderId!)).toBe(1);
  });

  it('the store never replaces a definite accept, not even with a definite refusal', async () => {
    const store = new InMemoryPreparedActionStore();
    const d = door(store);
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: 'bot-9184:order:store' });
    await store.signOnce(USER, prepared.actionKey, await sign(prepared.prepared), new Date());
    const accept: VenueSubmitOutcome = { definite: true, accepted: true, venueRef: '1', order: null, asOf: new Date(0) };
    await store.recordOutcome(USER, prepared.actionKey, accept);
    const refusal: VenueSubmitOutcome = {
      definite: true,
      accepted: false,
      refusal: { venueId: sim.venue.id, code: 'nonce_rejected', detail: 'Invalid nonce: nonce too low' },
      asOf: new Date(1),
    };
    expect(await store.recordOutcome(USER, prepared.actionKey, refusal)).toEqual(accept);
    expect(await store.recordOutcome(USER, prepared.actionKey, { definite: false, reason: 'timeout' })).toEqual(accept);
  });

  type Step = { kind: 'submit'; mode: Mode } | { kind: 'restart' } | { kind: 'read' };
  const steps = fc.array(
    fc.oneof(
      fc.record({ kind: fc.constant('submit' as const), mode: fc.constantFrom<Mode>('ok', 'late', 'lost', 'down', 'stale') }),
      fc.constant({ kind: 'restart' as const }),
      fc.constant({ kind: 'read' as const }),
    ),
    { minLength: 1, maxLength: 7 },
  );
  let run = 0;

  /**
   * Submit, timeout, late answer, retry, restart and read, over one key. Holds when: once a definite answer is recorded,
   * or once the venue holds the order, nothing more goes on the wire; the venue holds the order at most once; and an order
   * the venue holds is never shown or stored as refused.
   */
  async function holds(plan: Step[], plant: boolean): Promise<boolean> {
    const store = new InMemoryPreparedActionStore();
    let d = door(store, plant);
    mode = 'ok';
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: `bot-9184:prop:${plant}:${run++}` });
    const { nonce, venueClientOrderId } = prepared.prepared;
    const signature = await sign(prepared.prepared);
    const sends = () => wire.filter((n) => n === nonce).length;
    let settledAt: number | null = null;
    let heldAt: number | null = null;
    for (const step of plan) {
      if (step.kind === 'restart') {
        d = door(store, plant);
        continue;
      }
      mode = step.kind === 'read' ? 'ok' : step.mode;
      let shown: VenueSubmitOutcome | null = null;
      try {
        if (step.kind === 'read') await d.orderByKey(principal, prepared.actionKey);
        else shown = (await d.submit(principal, prepared.actionKey, signature)).outcome;
      } catch (err) {
        if (!(err instanceof VenueRefusalError && err.refusal.code === 'venue_down')) throw err;
      } finally {
        mode = 'ok';
      }
      const held = await onVenue(venueClientOrderId!);
      if (held > 1) return false;
      if (settledAt !== null && sends() > settledAt) return false;
      if (heldAt !== null && sends() > heldAt) return false;
      const stored = (await store.find(USER, prepared.actionKey))?.lastOutcome;
      if (held === 1 && ((shown?.definite && !shown.accepted) || (stored?.definite && !stored.accepted))) return false;
      if (stored?.definite && settledAt === null) settledAt = sends();
      if (held === 1 && heldAt === null) heldAt = sends();
    }
    return true;
  }

  it('property: at most one send for a key with a definite answer, and an unknown is read back, never re-sent or shown as failed', async () => {
    await fc.assert(
      fc.asyncProperty(steps, async (plan) => holds(plan, false)),
      { numRuns: 40 },
    );
  }, 120_000);

  it('the property fails on a planted re-send, so it can fail', async () => {
    const result = await fc.check(
      fc.asyncProperty(steps, async (plan) => holds(plan, true)),
      {
        numRuns: 40,
        examples: [
          [
            [
              { kind: 'submit', mode: 'ok' },
              { kind: 'submit', mode: 'ok' },
            ],
          ],
        ],
      },
    );
    expect(result.failed).toBe(true);
  }, 120_000);
});
