import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError, type StepUpCheck, type StepUpCheckRequest } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type VenueIntent,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore, type PreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, parseBuilderFee, type BuilderFeeValue } from './user-venue-door.js';

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111a1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333a3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

/** A TEST wallet with a fixed key, so every run signs the same bytes. */
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue door')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') };

/** A step-up that records what it was asked and answers as told. */
function stepUp(answer: 'approve' | 'required') {
  const calls: StepUpCheckRequest[] = [];
  const check: StepUpCheck = {
    async require(req) {
      calls.push(req);
      if (answer === 'required') throw new StepUpCheckError('confirm first', 'identity.step_up_required');
      return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
    },
  };
  return { check, calls };
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A loopback server that answers each request as `handle` says (or never). */
async function fakeVenue(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    if (req.url === '/venue') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          venue: { id: 'fake', displayName: 'fake TEST venue', kind: 'external-dex', sequencedDepth: true, proofLevel: 'simulator' },
          chainId: 84532,
        }),
      );
      return;
    }
    req.resume();
    req.on('end', () => handle(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

const somePrepared = (venueId: string): PreparedVenueAction => ({
  venueId,
  account: { venueId, owner, subAccount: null },
  signer,
  intent: { kind: 'revoke_agent', agentAddress: owner },
  nonce: '1',
  venueClientOrderId: null,
  typedData: {},
  digest: '0xabc',
  builderFee: null,
  preparedAt: new Date(),
});
const someSignature = { digest: '0xabc', signature: '0x00', signedBy: owner };

describe('HttpUserVenue: a lost answer after send is never definite', () => {
  it('a submit that times out after the request was sent is definite:false timeout', async () => {
    const { server, url } = await fakeVenue(() => undefined); // receives the body, never answers
    try {
      const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 200 });
      expect(venue.chainId).toBe(84532);
      expect(await venue.submit(somePrepared(venue.venue.id), someSignature)).toEqual({ definite: false, reason: 'timeout' });
    } finally {
      await closeServer(server);
    }
  });

  it('a connection dropped after the request was sent is definite:false connection_lost', async () => {
    const { server, url } = await fakeVenue((req) => req.socket.destroy());
    try {
      const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
      expect(await venue.submit(somePrepared(venue.venue.id), someSignature)).toEqual({ definite: false, reason: 'connection_lost' });
    } finally {
      await closeServer(server);
    }
  });

  it('a 5xx or an answer that does not parse after send is definite:false venue_error_after_send', async () => {
    let mode: '500' | 'garbage' | 'shape' = '500';
    const { server, url } = await fakeVenue((_req, res) => {
      res.writeHead(mode === '500' ? 500 : 200, { 'content-type': 'application/json' });
      res.end(mode === 'garbage' ? '{not json' : mode === 'shape' ? '{"accepted":true}' : '{"error":"boom"}');
    });
    try {
      const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
      for (const m of ['500', 'garbage', 'shape'] as const) {
        mode = m;
        expect(await venue.submit(somePrepared(venue.venue.id), someSignature)).toEqual({
          definite: false,
          reason: 'venue_error_after_send',
        });
      }
    } finally {
      await closeServer(server);
    }
  });

  it('a refused connection on submit is the venue being down, never a definite refusal of the action', async () => {
    const { server, url } = await fakeVenue(() => undefined);
    // A refused connection, raised the way undici raises it, on every call once `refuse` is set. Injected rather than
    // produced by closing the server: how a closed loopback port fails (refused, or a reset pooled socket) differs by
    // machine, and the code under test is the classification, not the kernel.
    let refuse = false;
    const refusing: typeof fetch = async (input, init) => {
      if (refuse)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return fetch(input, init);
    };
    const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 200, fetch: refusing });
    await closeServer(server);
    refuse = true;
    await expect(venue.balances({ venueId: venue.venue.id, owner, subAccount: null })).rejects.toMatchObject({
      refusal: { code: 'venue_down' },
    });
    // Nothing reached the venue on this attempt, but an earlier send of the same bytes may have: no answer about the action.
    await expect(venue.submit(somePrepared(venue.venue.id), someSignature)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    await expect(HttpUserVenue.connect({ baseUrl: url, timeoutMs: 200, fetch: refusing })).rejects.toMatchObject({
      refusal: { code: 'venue_down' },
    });
  });
});

describe('UserVenueDoor against the TEST simulator over loopback HTTP', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('200000'), 'deposit:test:1');
  });
  afterAll(async () => closeServer(server));

  function door(opts: { store?: PreparedActionStore; builder?: BuilderFeeValue | null; stepUp?: StepUpCheck; appEnv?: string } = {}) {
    const store = opts.store ?? new InMemoryPreparedActionStore();
    let connects = 0;
    const d = new UserVenueDoor({
      connect: async () => {
        connects += 1;
        return HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
      },
      appEnv: opts.appEnv ?? 'test',
      store,
      stepUp: opts.stepUp ?? stepUp('approve').check,
      builder: opts.builder === undefined ? BUILDER : opts.builder,
      now: () => new Date(),
    });
    return { d, store, connects: () => connects };
  }

  const order = (n: number, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.1'),
    price: a('60010'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:door-test:${n}`,
    builderFee: null,
    ...over,
  });

  it('prepare → sign (viem, fixed key) → submit → read, with our builder fee from the owner value', async () => {
    const { d } = door();
    const status = await d.status();
    expect(status).toMatchObject({ enabled: true, available: true, test: true, label: 'TEST', chainId: 84532 });

    // The builder fee approval first (owner-signed), keyed by the caller's own business key.
    const approve = await d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      actionKey: `approve-builder:${USER}:1`,
    });
    expect((await d.submit(principal, approve.actionKey, await sign(approve.prepared))).outcome).toMatchObject({
      definite: true,
      accepted: true,
    });

    const preview = await d.preview(principal, owner, order(1));
    expect(preview.value.role).toBe('taker');
    expect(preview.value.builderFee).toEqual({ known: true, value: { asset: 'BTC', amount: a('0.00001') } });

    // The request's own builder fee is replaced by the owner value.
    const prepared = await d.prepare(principal, { owner, signer, intent: order(1, { builderFee: { builder: owner, feeBps: a('0') } }) });
    expect(prepared.prepared.builderFee).toEqual({ builder: BUILDER.address, feeBps: a('1') });
    expect((prepared.prepared.typedData as TestVenueTypedData).domain.chainId).toBe(84532);
    const submitted = await d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
    expect(submitted.outcome).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });

    const venue = await d.venue();
    const account = await d.account(owner);
    const read = await venue.orderByClientId(account, prepared.prepared.venueClientOrderId as string);
    expect(read.value).toMatchObject({ status: 'filled', filled: a('0.1') });
    const fills = (await venue.fills(account, new Date(0))).value.filter(
      (f) => f.venueClientOrderId === prepared.prepared.venueClientOrderId,
    );
    expect(fills.reduce((s, f) => s + f.builderFee, 0n)).toBe(a('0.00001'));
  });

  it('council round 1: a send that landed but lost its answer, then a resend that hits a refused connection, stays not definite with its read-back', async () => {
    const store = new InMemoryPreparedActionStore();
    let refuseNext = false;
    const d = new UserVenueDoor({
      connect: async () => {
        const inner = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        // The same venue, except that the next submit meets a refused connection (as the client now reports it).
        return Object.assign(Object.create(inner) as typeof inner, {
          submit: async (prepared: PreparedVenueAction, signature: Parameters<typeof inner.submit>[1]) => {
            if (refuseNext) throw new VenueRefusalError({ venueId: inner.venue.id, code: 'venue_down', detail: 'connection refused' });
            return inner.submit(prepared, signature);
          },
        });
      },
      appEnv: 'test',
      store,
      stepUp: stepUp('approve').check,
      builder: BUILDER,
      now: () => new Date(),
    });
    const actionKey = `approve-builder:${USER}:council-r1`;
    const prepared = await d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      actionKey,
    });
    const signature = await sign(prepared.prepared);
    sim.switches.loseAnswers = 1; // applied by the venue, then the answer is lost
    const first = await d.submit(principal, actionKey, signature);
    expect(first.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(await sim.builderFeeApproval(await d.account(owner), BUILDER.address).then((r) => r.value)).toBe(a('1'));
    refuseNext = true;
    const second = await d.submit(principal, actionKey, signature);
    expect(second.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(second.readBack).toEqual({ nonce: prepared.prepared.nonce });
    expect((await store.find(USER, actionKey))?.lastOutcome).toEqual({ definite: false, reason: 'timeout' });
    // A first send that never reached the venue is still the venue being down: nothing was signed and sent before.
    const fresh = await d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
      actionKey: `${actionKey}:b`,
    });
    await expect(d.submit(principal, `${actionKey}:b`, await sign(fresh.prepared))).rejects.toMatchObject({
      refusal: { code: 'venue_down' },
    });
  });

  it('one prepared action per business key: a second prepare returns the stored action; a resubmit re-sends the same bytes', async () => {
    const { d, store } = door();
    const first = await d.prepare(principal, { owner, signer, intent: order(2, { price: a('59000') }) });
    const second = await d.prepare(principal, { owner, signer, intent: order(2, { price: a('59000') }) });
    expect(second.reused).toBe(true);
    expect(second.prepared.digest).toBe(first.prepared.digest);
    expect(second.prepared.nonce).toBe(first.prepared.nonce);

    // The same key for another intent is refused, never a second action.
    await expect(d.prepare(principal, { owner, signer, intent: order(2, { price: a('58000') }) })).rejects.toMatchObject({
      code: 'trade.venue_action_key_reused',
    });

    const signature = await sign(first.prepared);
    const sent = await d.submit(principal, first.actionKey, signature);
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true, order: { status: 'open' } });
    // A later submit with other bytes still sends the stored signature: the venue answers its first answer, one order.
    const again = await d.submit(principal, first.actionKey, { ...signature, signature: `${signature.signature.slice(0, -2)}00` });
    expect(again.outcome).toEqual(sent.outcome);
    expect((await store.find(USER, first.actionKey))?.signature?.signature).toBe(signature.signature);
    const open = (await (await d.venue()).openOrders(await d.account(owner))).value.filter(
      (o) => o.venueClientOrderId === first.prepared.venueClientOrderId,
    );
    expect(open).toHaveLength(1);
  });

  it('a lost submit answer is definite:false with where to read back; the re-send of the stored bytes is one order', async () => {
    const { d } = door();
    const p = await d.prepare(principal, { owner, signer, intent: order(3, { price: a('58500') }) });
    sim.switches.loseAnswers = 1;
    const lost = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(lost.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(lost.readBack).toEqual({ venueClientOrderId: p.prepared.venueClientOrderId });
    const resent = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(resent.outcome).toMatchObject({ definite: true, accepted: true });
    const open = (await (await d.venue()).openOrders(await d.account(owner))).value.filter(
      (o) => o.venueClientOrderId === p.prepared.venueClientOrderId,
    );
    expect(open).toHaveLength(1);
  });

  it('bad signature bytes are refused before they are stored; the key then completes with a good signature', async () => {
    const { d, store } = door();
    const p = await d.prepare(principal, { owner, signer, intent: order(6, { price: a('58200') }) });
    await expect(
      d.submit(principal, p.actionKey, { digest: p.prepared.digest, signature: '0xdead', signedBy: owner }),
    ).rejects.toMatchObject({
      refusal: { code: 'signature_mismatch' },
    });
    // A well-formed signature by another key, claiming our signer, is refused the same way.
    const other = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet someone else')));
    const t = p.prepared.typedData as TestVenueTypedData;
    const forged = await other.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    await expect(d.submit(principal, p.actionKey, { digest: p.prepared.digest, signature: forged, signedBy: owner })).rejects.toMatchObject(
      {
        refusal: { code: 'signature_mismatch' },
      },
    );
    expect((await store.find(USER, p.actionKey))?.signature).toBeNull();
    const ok = await d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(ok.outcome).toMatchObject({ definite: true, accepted: true });
  });

  it('a definite outcome is never replaced by a later not-definite one (in-memory store)', async () => {
    const store = new InMemoryPreparedActionStore();
    const k = `order:${USER}:door-test:outcome`;
    await store.insertOnce(USER, k, somePrepared('v'));
    const accepted = await store.recordOutcome(USER, k, { definite: false, reason: 'timeout' });
    expect(accepted).toEqual({ definite: false, reason: 'timeout' });
    const definite: VenueSubmitOutcome = {
      definite: true,
      accepted: false,
      refusal: { venueId: 'v', code: 'venue_down', detail: 'x' },
      asOf: new Date('2026-11-08T20:00:00.000Z'),
    };
    expect(await store.recordOutcome(USER, k, definite)).toEqual(definite);
    expect(await store.recordOutcome(USER, k, { definite: false, reason: 'already_submitted' })).toEqual(definite);
    expect((await store.find(USER, k))?.lastOutcome).toEqual(definite);
  });

  it('a changed builder fee between two prepares of one key refuses trade.venue_builder_fee_changed, not "key reused"', async () => {
    const store = new InMemoryPreparedActionStore();
    const before = door({ store });
    const approve = await before.d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('2') },
      actionKey: `approve-builder:${USER}:fee-change`,
    });
    await before.d.submit(principal, approve.actionKey, await sign(approve.prepared));
    await before.d.prepare(principal, { owner, signer, intent: order(7, { price: a('58300') }) });
    const after = door({ store, builder: { address: BUILDER.address, feeBps: a('2') } });
    await expect(after.d.prepare(principal, { owner, signer, intent: order(7, { price: a('58300') }) })).rejects.toMatchObject({
      code: 'trade.venue_builder_fee_changed',
      status: 409,
    });
    // Another change to the order is still "key reused".
    await expect(after.d.prepare(principal, { owner, signer, intent: order(7, { price: a('58400') }) })).rejects.toMatchObject({
      code: 'trade.venue_action_key_reused',
    });
  });

  it('blank builder fee: every order refuses builder_fee_not_published before the venue is asked', async () => {
    const { d, store } = door({ builder: null });
    await expect(d.prepare(principal, { owner, signer, intent: order(4) })).rejects.toMatchObject({
      refusal: { code: 'builder_fee_not_published' },
    });
    await expect(d.preview(principal, owner, order(4))).rejects.toMatchObject({ refusal: { code: 'builder_fee_not_published' } });
    expect(await store.find(USER, order(4).clientOrderKey)).toBeNull();
    expect(parseBuilderFee('', '1')).toBeNull();
    expect(parseBuilderFee(BUILDER.address, '  ')).toBeNull();
    expect(parseBuilderFee(BUILDER.address.toUpperCase().replace('0X', '0x'), '0.5')).toEqual({
      address: BUILDER.address,
      feeBps: a('0.5'),
    });
    expect(() => parseBuilderFee('not-an-address', '1')).toThrow(/0x address/);
  });

  it('a withdrawal or a grant of authority is refused from an API key or a sub-account token, before anything is asked or stored', async () => {
    const asked = stepUp('approve');
    const { d, store, connects } = door({ stepUp: asked.check });
    const keyPrincipal = { ...principal, kid: 'key-1' } as Principal;
    const subPrincipal = { ...principal, sub_account: '44444444-4444-4444-8444-4444444444a4' } as Principal;
    const withdraw: VenueIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: owner,
      withdrawalKey: `withdraw:${USER}:key`,
    };
    for (const who of [keyPrincipal, subPrincipal]) {
      await expect(d.prepare(who, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-1' })).rejects.toMatchObject({
        code: 'scope.interactive_only',
      });
      await expect(
        d.prepare(who, {
          owner,
          signer,
          intent: { kind: 'approve_agent', agentAddress: owner, agentName: 'bot', validUntil: null } as VenueIntent,
          actionKey: `agent:${USER}:1`,
        }),
      ).rejects.toMatchObject({ code: 'scope.interactive_only' });
    }
    expect(await store.find(USER, `withdraw:${USER}:key`)).toBeNull();
    expect(await store.find(USER, `agent:${USER}:1`)).toBeNull();
    expect(asked.calls).toHaveLength(0);
    expect(connects()).toBe(0);
    // A key still trades: an order from the same key is prepared as usual.
    const order1 = await d.prepare(keyPrincipal, { owner, signer, intent: order(1) });
    expect(order1.actionKey).toBe(order(1).clientOrderKey);
  });

  it('a withdrawal prepared in the session cannot be submitted from an API key', async () => {
    const { d } = door();
    const withdraw: VenueIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: owner,
      withdrawalKey: `withdraw:${USER}:sub`,
    };
    const p = await d.prepare(principal, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-1' });
    await expect(d.submit({ ...principal, kid: 'key-1' } as Principal, p.actionKey, await sign(p.prepared))).rejects.toMatchObject({
      code: 'scope.interactive_only',
    });
  });

  it('a withdrawal spends the step-up first: refused, nothing is prepared, stored or asked of the venue', async () => {
    const refused = stepUp('required');
    const { d, store, connects } = door({ stepUp: refused.check });
    const withdraw: VenueIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10.50'),
      destination: owner,
      withdrawalKey: `withdraw:${USER}:1`,
    };
    await expect(d.prepare(principal, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-1' })).rejects.toMatchObject({
      code: 'identity.step_up_required',
    });
    expect(connects()).toBe(0);
    expect(await store.find(USER, `withdraw:${USER}:1`)).toBeNull();
    expect(refused.calls[0]).toEqual({
      scope: 'trade.step_up.venue.withdraw',
      userId: USER,
      sessionId: principal.sid,
      approvalId: 'appr-1',
      fields: { withdrawalKey: `withdraw:${USER}:1`, owner, subAccount: '', asset: 'USDC', amount: '10.5', destination: owner },
      requestId: `venue.withdraw:withdraw:${USER}:1`,
    });

    // Approved, it prepares, signs and lands; a lost answer reads back by nonce.
    const ok = door();
    const p = await ok.d.prepare(principal, { owner, signer, intent: withdraw, stepUpApprovalId: 'appr-1' });
    const out = await ok.d.submit(principal, p.actionKey, await sign(p.prepared));
    expect(out.outcome).toMatchObject({ definite: true, accepted: true });
    const read = await (await ok.d.venue()).withdrawal(await ok.d.account(owner), p.prepared.nonce);
    expect(read.value).toMatchObject({ status: 'pending', amount: a('10.5') });
  });

  it('refuses a TEST venue outside APP_ENV dev or test, and keys that are not business keys', async () => {
    for (const appEnv of ['prod', '', 'staging']) {
      const { d } = door({ appEnv });
      await expect(d.venue()).rejects.toMatchObject({ refusal: { code: 'test_venue_outside_test' } });
      expect(await d.status()).toMatchObject({ enabled: true, available: false, refusal: { code: 'test_venue_outside_test' } });
    }
    const { d } = door();
    await expect(
      d.prepare(principal, { owner, signer, intent: order(5, { clientOrderKey: '6f1c1a8e-9d0b-4c43-8e8e-0e9c3b1f2a10' }) }),
    ).rejects.toMatchObject({
      code: 'trade.venue_action_key_invalid',
    });
    await expect(
      d.prepare(principal, {
        owner,
        signer,
        intent: { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' },
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_action_key_invalid' });
  });
});
