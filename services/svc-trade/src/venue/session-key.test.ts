import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck, StepUpCheckRequest } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { InMemoryPreparedActionStore, type PreparedActionStore } from './prepared-action-store.js';
import { SESSION_KEY_TTL_MS, SessionKeys } from './session-key.js';
import { UserVenueDoor, UserVenueDoorError, type BuilderFeeValue } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-wallet-22 #8 / D-venue-09 against the TEST venue simulator, in process: one owner approval per session for a fresh
// session key that trades and never withdraws. The owner is a plain TEST key here, as the person's own wallet is
// (J-wallet-09); the embedded wallet (J-wallet-22) signs the same typed data at its provider, after the passkey.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111a1';
const SIGN_IN_A = '44444444-4444-4444-8444-4444444444a1';
const SIGN_IN_B = '44444444-4444-4444-8444-4444444444b2';
const person = (fam: string | undefined, extra: Partial<Principal> = {}) =>
  ({
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-3333333333a3',
    ...(fam ? { fam } : {}),
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
    ...extra,
  }) as Principal;

const ownerKey = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade session key')));
const owner = ownerKey.address.toLowerCase();
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') };

async function signWith(key: PrivateKeyAccount, prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

function world(opts: { store?: PreparedActionStore } = {}) {
  let now = new Date('2026-11-09T10:00:00.000Z');
  const clock = () => now;
  const sim = new TestVenueSimulator({ clock, markets: TEST_VENUE_MARKETS });
  const store = opts.store ?? new InMemoryPreparedActionStore();
  const stepUps: StepUpCheckRequest[] = [];
  const stepUp: StepUpCheck = {
    async require(req) {
      stepUps.push(req);
      return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
    },
  };
  const door = new UserVenueDoor({
    connect: async () => sim,
    appEnv: 'test',
    store,
    stepUp,
    builder: BUILDER,
    now: clock,
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
  });
  const sessions = new SessionKeys({ door, store, now: clock });
  const account = { venueId: sim.venue.id, owner, subAccount: null };
  sim.deposit(account, 'USDC', a('100000'), 'test:session-key:usdc');
  let ownerPrompts = 0;
  /** The owner wallet's signature: one passkey prompt each. */
  const ownerSign = async (prepared: PreparedVenueAction) => {
    ownerPrompts += 1;
    return signWith(ownerKey, prepared);
  };
  return {
    sim,
    door,
    sessions,
    store,
    stepUps,
    account,
    ownerPrompts: () => ownerPrompts,
    ownerSign,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

/** Start a trading session on `fam` with a fresh key and sign its one approval with the owner wallet. */
async function startSession(w: World, fam = SIGN_IN_A, privateKey = generatePrivateKey()) {
  const key = privateKeyToAccount(privateKey);
  const p = person(fam);
  const started = await w.sessions.start(p, owner, key.address);
  const sent = await w.door.submit(p, started.actionKey, await w.ownerSign(started.prepared));
  return { key, privateKey, started, sent, p };
}

let orderN = 0;
const order = (side: 'buy' | 'sell' = 'buy'): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  amount: a('0.001'),
  price: a('1000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${USER}:session-key-test:${++orderN}`,
  builderFee: null,
});

/** An order signed on the device by the session key: prepared with the agent signer, no owner prompt. */
async function placeWithSessionKey(w: World, p: Principal, key: PrivateKeyAccount) {
  const intent = order();
  const prepared = await w.door.prepare(p, { owner, signer: { role: 'agent', address: key.address.toLowerCase() }, intent });
  return w.door.submit(p, prepared.actionKey, await signWith(key, prepared.prepared));
}

async function approveBuilderFee(w: World) {
  const p = person(SIGN_IN_A);
  const prepared = await w.door.prepare(p, {
    owner,
    signer: { role: 'owner', address: owner },
    intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
    actionKey: `builder-fee:${USER}:${w.sim.venue.id}`,
  });
  await w.door.submit(p, prepared.actionKey, await signWith(ownerKey, prepared.prepared));
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof VenueRefusalError) return err.refusal.code;
    if (err instanceof UserVenueDoorError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('J-wallet-22 #8: one approval per trading session for a fresh key that trades and never withdraws', () => {
  it('one owner approval, unnamed, with the session expiry; two orders signed by the session key with no second prompt', async () => {
    const w = world();
    await approveBuilderFee(w);
    const before = w.ownerPrompts();
    const { key, privateKey, started, sent, p } = await startSession(w);
    expect(started.actionKey).toBe(`session-key:${USER}:${w.sim.venue.id}:${SIGN_IN_A}.1`);
    expect(started.prepared.intent).toEqual({
      kind: 'approve_agent',
      agentAddress: key.address.toLowerCase(),
      agentName: '',
      validUntil: new Date(Date.parse('2026-11-09T10:00:00.000Z') + SESSION_KEY_TTL_MS),
    });
    expect(started.prepared.signer).toEqual({ role: 'owner', address: owner });
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });

    const first = await placeWithSessionKey(w, p, key);
    const second = await placeWithSessionKey(w, p, key);
    for (const placed of [first, second]) expect(placed.outcome).toMatchObject({ definite: true, accepted: true });
    expect(w.ownerPrompts() - before).toBe(1);
    // The venue's own record: both orders are open on the person's account, and the key is listed with its expiry.
    expect((await w.sim.openOrders(w.account)).value).toHaveLength(2);
    expect((await w.sim.agents(w.account)).value).toEqual([
      {
        address: key.address.toLowerCase(),
        name: '',
        validUntil: started.prepared.intent.kind === 'approve_agent' ? started.prepared.intent.validUntil : null,
      },
    ]);
    const status = await w.sessions.status(p, owner);
    expect(status.current).toMatchObject({ state: 'live', agentAddress: key.address.toLowerCase(), sessionId: `${SIGN_IN_A}.1` });
    // We store the address, its expiry and the venue's answer; never a key.
    const stored = JSON.stringify(await w.store.listByPrefix(USER, 'session-key:'));
    expect(stored).toContain(key.address.toLowerCase());
    expect(stored.toLowerCase()).not.toContain(privateKey.slice(2).toLowerCase());
  });

  it('a second press before the approval is signed is the same stored approval: one prompt, never two', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const one = await w.sessions.start(p, owner, key.address);
    const two = await w.sessions.start(p, owner, key.address);
    expect(two).toMatchObject({ actionKey: one.actionKey, reused: true, signed: false });
    expect(two.prepared.digest).toBe(one.prepared.digest);
  });

  it('the approval times out: read back with agents(), never asked twice for one business key', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const started = await w.sessions.start(p, owner, key.address);
    w.sim.loseAnswersOn(w.account, 1);
    const sent = await w.door.submit(p, started.actionKey, await w.ownerSign(started.prepared));
    expect(sent.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(sent.readBack).toEqual({ nonce: started.prepared.nonce });
    // The venue applied it: the read-back finds the key live, from the venue's agents() list.
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'live', onVenue: { address: key.address.toLowerCase() } });
    // Pressing Start again with the same key is the same signed approval, not a new prompt.
    const again = await w.sessions.start(p, owner, key.address);
    expect(again).toMatchObject({ actionKey: started.actionKey, reused: true, signed: true });
    expect(w.ownerPrompts()).toBe(1);
  });

  it('an approval sent with no answer that the venue never got: approving, re-sent with the same bytes, and no new session meanwhile', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const started = await w.sessions.start(p, owner, key.address);
    const signature = await w.ownerSign(started.prepared);
    w.sim.switches.venueDown = true;
    await expect(w.door.submit(p, started.actionKey, signature)).rejects.toThrow(/venue_down|down/);
    w.sim.switches.venueDown = false;
    expect((await w.sessions.status(p, owner)).current?.state).toBe('approving');
    expect(await refusal(w.sessions.start(p, owner, privateKeyToAccount(generatePrivateKey()).address))).toBe(
      'trade.venue_session_pending',
    );
    // Same key: the same stored, signed approval; re-sent, it lands.
    const again = await w.sessions.start(p, owner, key.address);
    expect(again).toMatchObject({ actionKey: started.actionKey, reused: true, signed: true });
    const resent = await w.door.submit(p, started.actionKey, signature);
    expect(resent.outcome).toMatchObject({ definite: true, accepted: true });
    expect((await w.sessions.status(p, owner)).current?.state).toBe('live');
    expect(w.ownerPrompts()).toBe(1);
  });

  it('the session key trying a withdrawal is refused agent_not_permitted before any step-up, and nothing is stored or sent', async () => {
    const w = world();
    const { key, p } = await startSession(w);
    const code = await refusal(
      w.door.prepare(p, {
        owner,
        signer: { role: 'agent', address: key.address.toLowerCase() },
        intent: {
          kind: 'withdraw',
          asset: 'USDC',
          amount: a('10'),
          destination: owner,
          withdrawalKey: `withdraw:${USER}:session-key-test`,
        },
        stepUpApprovalId: 'approval-1',
      }),
    );
    expect(code).toBe('agent_not_permitted');
    expect(w.stepUps).toEqual([]);
    expect(await w.store.find(USER, `withdraw:${USER}:session-key-test`)).toBeNull();
    expect((await w.sim.balances(w.account)).value.find((b) => b.asset === 'USDC')?.free).toBe(a('100000'));
    // Nor may it approve another key or revoke itself.
    for (const intent of [
      {
        kind: 'approve_agent' as const,
        agentAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(),
        agentName: '',
        validUntil: null,
      },
      { kind: 'revoke_agent' as const, agentAddress: key.address.toLowerCase() },
    ]) {
      expect(
        await refusal(
          w.door.prepare(p, {
            owner,
            signer: { role: 'agent', address: key.address.toLowerCase() },
            intent,
            actionKey: `agent-try:${USER}:${intent.kind}`,
          }),
        ),
      ).toBe('agent_not_permitted');
    }
  });

  it('the key expires mid-session: the order is refused signer_not_authorised and the status says expired', async () => {
    const w = world();
    await approveBuilderFee(w);
    const { key, p } = await startSession(w);
    expect((await placeWithSessionKey(w, p, key)).outcome).toMatchObject({ accepted: true });
    w.advance(SESSION_KEY_TTL_MS + 1);
    expect(await refusal(placeWithSessionKey(w, p, key))).toBe('signer_not_authorised');
    expect((await w.sessions.status(p, owner)).current?.state).toBe('expired');
    // The next session approves a new key.
    const next = await startSession(w);
    expect(next.started.sessionId).toBe(`${SIGN_IN_A}.2`);
    expect(next.key.address).not.toBe(key.address);
    expect((await placeWithSessionKey(w, p, next.key)).outcome).toMatchObject({ accepted: true });
  });

  it('ending the session revokes the key on the venue; an order signed by it is refused; it is never approved again, by any route', async () => {
    const w = world();
    await approveBuilderFee(w);
    const { key, p } = await startSession(w);
    const end = await w.sessions.end(p, owner);
    expect(end.actionKey).toBe(`session-key-end:${USER}:${w.sim.venue.id}:${SIGN_IN_A}.1`);
    expect(end.prepared.intent).toEqual({ kind: 'revoke_agent', agentAddress: key.address.toLowerCase() });
    expect((await w.door.submit(p, end.actionKey, await w.ownerSign(end.prepared))).outcome).toMatchObject({ accepted: true });
    expect((await w.sim.agents(w.account)).value).toEqual([]);
    expect((await w.sessions.status(p, owner)).current?.state).toBe('ended');
    expect(await refusal(placeWithSessionKey(w, p, key))).toBe('signer_not_authorised');
    expect(await refusal(w.sessions.end(p, owner))).toBe('trade.venue_session_none');

    // A new session with the old key: refused here, and on a new sign-in, and through the plain door.
    expect(await refusal(w.sessions.start(p, owner, key.address))).toBe('trade.venue_session_key_reused');
    expect(await refusal(w.sessions.start(person(SIGN_IN_B), owner, key.address))).toBe('trade.venue_session_key_reused');
    expect(
      await refusal(
        w.door.prepare(p, {
          owner,
          signer: { role: 'owner', address: owner },
          intent: { kind: 'approve_agent', agentAddress: key.address.toLowerCase(), agentName: 'mine', validUntil: null },
          actionKey: `agent-approve:${USER}:again`,
        }),
      ),
    ).toBe('trade.venue_session_key_reused');
    // The session's own keys cannot be written through the plain door at all.
    expect(
      await refusal(
        w.door.prepare(p, {
          owner,
          signer: { role: 'owner', address: owner },
          intent: {
            kind: 'approve_agent',
            agentAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(),
            agentName: '',
            validUntil: null,
          },
          actionKey: `session-key:${USER}:${w.sim.venue.id}:${SIGN_IN_A}.9`,
        }),
      ),
    ).toBe('trade.venue_action_key_reserved');
    const fresh = await startSession(w);
    expect(fresh.started.sessionId).toBe(`${SIGN_IN_A}.2`);
    expect((await w.sim.agents(w.account)).value.map((x) => x.address)).toEqual([fresh.key.address.toLowerCase()]);
  });

  it('a second device’s session replaces the first device’s key; the first says replaced; a named agent is never replaced', async () => {
    const w = world();
    await approveBuilderFee(w);
    // A named agent on the main account (the J-agents-21 assistant has its own, on its sub-account): approved by the owner.
    const assistant = privateKeyToAccount(generatePrivateKey());
    const named = await w.door.prepare(person(SIGN_IN_A), {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_agent', agentAddress: assistant.address.toLowerCase(), agentName: 'assistant', validUntil: null },
      actionKey: `agent-approve:${USER}:assistant`,
    });
    await w.door.submit(person(SIGN_IN_A), named.actionKey, await signWith(ownerKey, named.prepared));

    const first = await startSession(w, SIGN_IN_A);
    const second = await startSession(w, SIGN_IN_B);
    expect((await w.sessions.status(first.p, owner)).current).toMatchObject({ state: 'replaced', replacedBy: 'another_sign_in' });
    expect((await w.sessions.status(second.p, owner)).current).toMatchObject({ state: 'live' });
    expect(await refusal(placeWithSessionKey(w, first.p, first.key))).toBe('signer_not_authorised');
    expect((await placeWithSessionKey(w, second.p, second.key)).outcome).toMatchObject({ accepted: true });
    const listed = (await w.sim.agents(w.account)).value.map((x) => [x.address, x.name]);
    expect(listed).toEqual(
      expect.arrayContaining([
        [assistant.address.toLowerCase(), 'assistant'],
        [second.key.address.toLowerCase(), ''],
      ]),
    );
    expect(listed).toHaveLength(2);
    // The replaced key is never approved again, even by the device that held it.
    expect(await refusal(w.sessions.start(first.p, owner, first.key.address))).toBe('trade.venue_session_key_reused');
  });

  it('only the person’s own signed-in session starts a trading session: never an API key, a sub-account token, or a token with no sign-in', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey()).address;
    await expect(w.sessions.start(person(SIGN_IN_A, { kid: 'key-1' } as Partial<Principal>), owner, key)).rejects.toMatchObject({
      code: 'scope.interactive_only',
    });
    await expect(w.sessions.start(person(SIGN_IN_A, { sub_account: 'sub-1' } as Partial<Principal>), owner, key)).rejects.toMatchObject({
      code: 'scope.interactive_only',
    });
    expect(await refusal(w.sessions.start(person(undefined), owner, key))).toBe('trade.venue_session_unavailable');
    expect(await refusal(w.sessions.start(person(SIGN_IN_A), owner, owner))).toBe('trade.venue_request_invalid');
    expect(await refusal(w.sessions.start(person(SIGN_IN_A), owner, 'not-an-address'))).toBe('trade.venue_request_invalid');
  });

  it('a key approved before is refused for good: on another venue account, and after a plain-door approval and revoke', async () => {
    const w = world();
    const { key, p } = await startSession(w);
    const end = await w.sessions.end(p, owner);
    await w.door.submit(p, end.actionKey, await w.ownerSign(end.prepared));
    // The same key on another of the person's venue accounts (another wallet they own).
    const otherOwner = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade session key, second wallet')));
    expect(await refusal(w.sessions.start(p, otherOwner.address, key.address))).toBe('trade.venue_session_key_reused');

    // A key approved through the plain door, then revoked, never becomes a session key.
    const plain = privateKeyToAccount(generatePrivateKey());
    const approve = await w.door.prepare(p, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_agent', agentAddress: plain.address.toLowerCase(), agentName: 'tool', validUntil: null },
      actionKey: `agent-approve:${USER}:tool`,
    });
    await w.door.submit(p, approve.actionKey, await signWith(ownerKey, approve.prepared));
    const revoke = await w.door.prepare(p, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'revoke_agent', agentAddress: plain.address.toLowerCase() },
      actionKey: `agent-revoke:${USER}:tool`,
    });
    await w.door.submit(p, revoke.actionKey, await signWith(ownerKey, revoke.prepared));
    expect(await refusal(w.sessions.start(person(SIGN_IN_B), owner, plain.address))).toBe('trade.venue_session_key_reused');
  });

  it('an approval left unsigned is abandoned when a newer session starts: it can never be signed and sent later', async () => {
    const w = world();
    const p = person(SIGN_IN_A);
    const stale = await w.sessions.start(p, owner, privateKeyToAccount(generatePrivateKey()).address);
    const fresh = await startSession(w);
    expect(fresh.started.sessionId).toBe(`${SIGN_IN_A}.2`);
    expect(await refusal(w.door.submit(p, stale.actionKey, await signWith(ownerKey, stale.prepared)))).toBe(
      'trade.venue_session_superseded',
    );
    expect((await w.sim.agents(w.account)).value.map((x) => x.address)).toEqual([fresh.key.address.toLowerCase()]);
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'live', sessionId: `${SIGN_IN_A}.2` });
  });

  it('a newer session on ANOTHER wallet does not abandon this wallet’s unsigned approval: it is signed and sent, and goes live', async () => {
    const w = world();
    const p = person(SIGN_IN_A);
    const key = privateKeyToAccount(generatePrivateKey());
    const here = await w.sessions.start(p, owner, key.address);
    const second = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade session key, second wallet')));
    w.sim.deposit({ venueId: w.sim.venue.id, owner: second.address.toLowerCase(), subAccount: null }, 'USDC', a('1'), 'test:second');
    const there = await w.sessions.start(p, second.address, privateKeyToAccount(generatePrivateKey()).address);
    expect(there.sessionId).toBe(`${SIGN_IN_A}.2`);
    const sent = await w.door.submit(p, here.actionKey, await w.ownerSign(here.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'live', agentAddress: key.address.toLowerCase() });
  });

  it('a newer session left unsigned does not hide the live one: End still revokes the key the venue lists', async () => {
    const w = world();
    const { key, p } = await startSession(w);
    const cancelled = await w.sessions.start(p, owner, privateKeyToAccount(generatePrivateKey()).address);
    expect(cancelled.sessionId).toBe(`${SIGN_IN_A}.2`);
    const end = await w.sessions.end(p, owner);
    expect(end.sessionId).toBe(`${SIGN_IN_A}.1`);
    expect(end.prepared.intent).toEqual({ kind: 'revoke_agent', agentAddress: key.address.toLowerCase() });
    expect((await w.door.submit(p, end.actionKey, await w.ownerSign(end.prepared))).outcome).toMatchObject({ accepted: true });
    expect((await w.sim.agents(w.account)).value).toEqual([]);
  });

  it('a key the venue lists reads live even when a re-send of its approval was refused', async () => {
    const w = world();
    const { key, p, started } = await startSession(w);
    await w.store.recordOutcome(
      USER,
      started.actionKey,
      { definite: true, accepted: false, refusal: { venueId: w.sim.venue.id, code: 'nonce_reused', detail: 'TEST: duplicate' } } as never,
      new Date('2026-11-09T10:00:01.000Z'),
    );
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'live', agentAddress: key.address.toLowerCase() });
  });

  it('an approval whose answer was lost and that the venue no longer lists past its expiry reads expired, and a new session may start', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const started = await w.sessions.start(p, owner, key.address);
    const signature = await w.ownerSign(started.prepared);
    w.sim.switches.venueDown = true;
    await expect(w.door.submit(p, started.actionKey, signature)).rejects.toThrow();
    w.sim.switches.venueDown = false;
    expect((await w.sessions.status(p, owner)).current?.state).toBe('approving');
    w.advance(SESSION_KEY_TTL_MS + 1);
    expect((await w.sessions.status(p, owner)).current?.state).toBe('expired');
    const next = await startSession(w);
    expect(next.started.sessionId).toBe(`${SIGN_IN_A}.2`);
  });

  it('a session whose answer was lost, read back live, then replaced by another device, reads replaced, and its approval is never re-sent', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const started = await w.sessions.start(p, owner, key.address);
    w.sim.loseAnswersOn(w.account, 1);
    expect((await w.door.submit(p, started.actionKey, await w.ownerSign(started.prepared))).outcome).toEqual({
      definite: false,
      reason: 'timeout',
    });
    // The room reads it back: the venue lists the key, so it is live, and that it landed is now on record.
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'live' });
    const other = await startSession(w, SIGN_IN_B);
    expect(other.sent.outcome).toMatchObject({ accepted: true });
    // Gone from the venue now, and replaced: never `approving`, which would re-send its approval over the newer key.
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'replaced', replacedBy: 'another_sign_in' });
    expect((await w.sim.agents(w.account)).value.map((x) => x.address)).toEqual([other.key.address.toLowerCase()]);
    expect(await refusal(w.sessions.start(p, owner, key.address))).toBe('trade.venue_session_key_reused');
  });

  it('an approval the venue never got, superseded by another device’s session, ends: its stored bytes are never re-sent', async () => {
    const w = world();
    const key = privateKeyToAccount(generatePrivateKey());
    const p = person(SIGN_IN_A);
    const started = await w.sessions.start(p, owner, key.address);
    w.sim.switches.venueDown = true;
    await expect(w.door.submit(p, started.actionKey, await w.ownerSign(started.prepared))).rejects.toThrow(/venue_down|down/);
    w.sim.switches.venueDown = false;
    expect((await w.sessions.status(p, owner)).current?.state).toBe('approving');
    // Another device's session lands meanwhile. This one never landed: re-sending it now could put its key back over
    // the newer one, so it ends instead of staying out.
    const other = await startSession(w, SIGN_IN_B);
    expect(other.sent.outcome).toMatchObject({ accepted: true });
    expect((await w.sessions.status(p, owner)).current).toMatchObject({ state: 'ended' });
    expect((await w.sim.agents(w.account)).value.map((x) => x.address)).toEqual([other.key.address.toLowerCase()]);
  });

  it('planted fault: blind the door’s one never-again check and the old key reaches the venue, whose retired-agent rule is all that stops it', async () => {
    // The planted fault: a store whose agent-approval history is empty, so the door's check sees no earlier approval.
    class Blind extends InMemoryPreparedActionStore {
      override async agentApprovals() {
        return [];
      }
    }
    const blind = world({ store: new Blind() });
    const { key, p } = await startSession(blind);
    const end = await blind.sessions.end(p, owner);
    await blind.door.submit(p, end.actionKey, await blind.ownerSign(end.prepared));
    // The old key gets past our check; only the venue's own rule (a revoked agent is never approved again) refuses it,
    // at prepare, with nothing signed.
    expect(await refusal(blind.sessions.start(person(SIGN_IN_B), owner, key.address))).toBe('venue_rejected');
    expect(blind.ownerPrompts()).toBe(2);

    // Without the fault, our check refuses first, before the venue or the owner is asked anything.
    const w = world();
    const real = await startSession(w);
    const realEnd = await w.sessions.end(real.p, owner);
    await w.door.submit(real.p, realEnd.actionKey, await w.ownerSign(realEnd.prepared));
    expect(await refusal(w.sessions.start(person(SIGN_IN_B), owner, real.key.address))).toBe('trade.venue_session_key_reused');
  });
});
