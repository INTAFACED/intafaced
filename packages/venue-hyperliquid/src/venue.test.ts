import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
} from '@intafaced/venue-contracts';
import {
  actionHash,
  HyperliquidNetworkRefusedError,
  typedDataDigest,
  type HlTypedData,
  type L1TypedData,
  type UserSignedTypedData,
} from './signing.js';
import {
  FILLS_PAGE_CAP,
  HL_TESTNET_VENUE_ID,
  HyperliquidTestnetUserVenue,
  InMemoryNonceSource,
  PERP_COLLATERAL_ASSET,
  mapOrderStatus,
  type FetchLike,
  type HyperliquidNonceSource,
} from './venue.js';
import type { MsgpackValue } from './msgpack.js';

const a = parseAmount;
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const BUILDER = '0x00000000000000000000000000000000000b1d01';

/** TEST keys derived from a label, so every run signs the same bytes. Never a real key. */
function testKey(label: string) {
  return privateKeyToAccount(keccak256(toHex(`intafaced TEST hl wallet ${label}`)));
}
const ownerKey = testKey('owner');
const agentKey = testKey('agent');
const strangerKey = testKey('stranger');
const OWNER = ownerKey.address.toLowerCase();
const AGENT = agentKey.address.toLowerCase();
const account: UserVenueAccount = { venueId: HL_TESTNET_VENUE_ID, owner: OWNER, subAccount: null };
const ownerSigner: VenueSigner = { role: 'owner', address: OWNER };
const agentSigner: VenueSigner = { role: 'agent', address: AGENT };

async function sign(key: ReturnType<typeof testKey>, prepared: PreparedVenueAction): Promise<VenueSignature> {
  const typed = prepared.typedData as HlTypedData;
  const signature =
    typed.primaryType === 'Agent' ? await key.signTypedData(typed as L1TypedData) : await key.sign({ hash: typedDataDigest(typed) });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

type Answer = { status: number; body: string } | 'timeout' | 'drop' | 'drop-body';
interface Fake {
  fetch: FetchLike;
  exchangeBodies: Record<string, unknown>[];
  infoTypes: string[];
  exchange: Answer[];
  info: Record<string, (body: Record<string, unknown>) => unknown>;
}

const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
    { name: 'ISO', szDecimals: 0, maxLeverage: 3, onlyIsolated: true },
  ],
};
const SPOT_META = {
  tokens: [
    { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0 },
    { name: 'PURR', szDecimals: 0, weiDecimals: 5, index: 1 },
  ],
  universe: [{ name: 'PURR/USDC', tokens: [1, 0], index: 0 }],
};

function fakeVenue(): Fake {
  const fake: Fake = {
    exchangeBodies: [],
    infoTypes: [],
    exchange: [],
    info: {
      meta: () => META,
      spotMeta: () => SPOT_META,
      extraAgents: () => [{ name: 'TEST bot', address: AGENT, validUntil: NOW + 86_400_000 }],
      maxBuilderFee: () => 10, // 1 bp, in tenths
      orderStatus: (b) => ({
        status: 'order',
        order: {
          status: 'open',
          statusTimestamp: NOW,
          order: {
            coin: 'ETH',
            side: 'B',
            limitPx: '2000',
            sz: '0.5',
            origSz: '0.5',
            oid: 77,
            cloid: b.oid,
            tif: 'Gtc',
            orderType: 'Limit',
            reduceOnly: false,
          },
        },
      }),
      activeAssetData: () => ({ leverage: { type: 'cross', value: 10 } }),
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.endsWith('/info')) {
        fake.infoTypes.push(String(body.type));
        const handler = fake.info[String(body.type)];
        if (!handler) return { ok: false, status: 400, text: async () => 'unknown info type' };
        return { ok: true, status: 200, text: async () => JSON.stringify(handler(body)) };
      }
      fake.exchangeBodies.push(body);
      const answer = fake.exchange.shift() ?? { status: 200, body: JSON.stringify({ status: 'ok', response: { type: 'default' } }) };
      if (answer === 'drop') throw new TypeError('fetch failed: socket hang up');
      if (answer === 'timeout') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      if (answer === 'drop-body') return { ok: true, status: 200, text: async () => Promise.reject(new TypeError('terminated')) };
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => answer.body };
    },
  };
  return fake;
}

function venueWith(fake: Fake, timeoutMs = 50) {
  return new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(NOW), timeoutMs });
}

function order(extra: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol: 'ETH-PERP',
    side: 'buy',
    type: 'limit',
    amount: a('0.5'),
    price: a('2000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: 'order:test-user:desk:1',
    builderFee: null,
    ...extra,
  };
}

async function refusedWith(promise: Promise<unknown>, code: VenueRefusalCode): Promise<VenueRefusalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    expect((error as VenueRefusalError).refusal.code).toBe(code);
    return error as VenueRefusalError;
  }
  throw new Error(`expected a ${code} refusal`);
}

const ok = (response: unknown) => ({ status: 200, body: JSON.stringify({ status: 'ok', response }) });
const orderStatus = (s: unknown) => ok({ type: 'order', data: { statuses: [s] } });
const err = (text: string) => ({ status: 200, body: JSON.stringify({ status: 'err', response: text }) });

describe('testnet only', () => {
  it('refuses a mainnet base URL, typed', () => {
    expect(() => new HyperliquidTestnetUserVenue({ appEnv: 'test', baseUrl: 'https://api.hyperliquid.xyz' })).toThrow(
      HyperliquidNetworkRefusedError,
    );
  });

  it('is a TEST venue, refused outside APP_ENV dev or test', () => {
    for (const appEnv of ['production', 'staging', '', undefined, null]) {
      try {
        new HyperliquidTestnetUserVenue({ appEnv });
        expect.unreachable();
      } catch (error) {
        expect((error as VenueRefusalError).refusal.code).toBe('test_venue_outside_test');
      }
    }
    const v = new HyperliquidTestnetUserVenue({ appEnv: 'dev' });
    expect(v.venue.proofLevel).toBe('partner-sandbox');
    expect(v.venue.displayName).toMatch(/^TEST /);
  });
});

describe('prepare builds exactly what the wallet signs', () => {
  it('an order: phantom agent source "b", the cloid from the business key, the builder fee on the order', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, order({ builderFee: { builder: BUILDER, feeBps: a('0.5') } }));
    const typed = prepared.typedData as L1TypedData;
    expect(typed.primaryType).toBe('Agent');
    expect(typed.message.source).toBe('b');
    expect(typed.domain).toEqual({
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    });
    const cloid = venueClientOrderId(HL_TESTNET_VENUE_ID, 'order:test-user:desk:1');
    expect(prepared.venueClientOrderId).toBe(cloid);
    expect(prepared.nonce).toBe(String(NOW));
    const action = {
      type: 'order',
      orders: [{ a: 1, b: true, p: '2000', s: '0.5', r: false, t: { limit: { tif: 'Gtc' } }, c: cloid }],
      grouping: 'na',
      builder: { b: BUILDER, f: 5 },
    };
    expect(typed.message.connectionId).toBe(actionHash(action, null, BigInt(NOW)));
    expect(prepared.digest).toBe(typedDataDigest(typed));
    expect(prepared.builderFee).toEqual({ builder: BUILDER, feeBps: a('0.5') });

    // What goes on the wire is the same action, in the same key order, with the signature split as the venue takes it.
    fake.exchange.push(orderStatus({ resting: { oid: 77, cloid } }));
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(outcome.definite && outcome.accepted).toBe(true);
    const posted = fake.exchangeBodies[0]!;
    expect(JSON.stringify(posted.action)).toBe(JSON.stringify(action));
    expect(posted.nonce).toBe(NOW);
    expect(posted.vaultAddress).toBeNull();
    expect(Object.keys(posted.signature as object)).toEqual(['r', 's', 'v']);
  });

  it('the same intent maps to the same cloid every time; nonces strictly increase', async () => {
    const venue = venueWith(fakeVenue());
    const first = await venue.prepare(account, ownerSigner, order());
    const second = await venue.prepare(account, ownerSigner, order());
    expect(second.venueClientOrderId).toBe(first.venueClientOrderId);
    expect(BigInt(second.nonce) > BigInt(first.nonce)).toBe(true);
  });

  it('a sub-account order sets the vault flag to the sub-account', async () => {
    const sub = '0x1719884eb866cb12b2287399b15f7db5e7d775ea';
    const venue = venueWith(fakeVenue());
    const prepared = await venue.prepare({ ...account, subAccount: sub }, ownerSigner, order());
    const action: MsgpackValue = {
      type: 'order',
      orders: [{ a: 1, b: true, p: '2000', s: '0.5', r: false, t: { limit: { tif: 'Gtc' } }, c: prepared.venueClientOrderId! }],
      grouping: 'na',
    };
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(actionHash(action, sub, BigInt(prepared.nonce)));
    expect((prepared.typedData as L1TypedData).message.connectionId).not.toBe(actionHash(action, null, BigInt(prepared.nonce)));
  });

  it('a market order goes as IOC at its worst price; post-only market is refused', async () => {
    const venue = venueWith(fakeVenue());
    const prepared = await venue.prepare(account, ownerSigner, order({ type: 'market', timeInForce: 'GTC', price: a('2100') }));
    const cloid = prepared.venueClientOrderId!;
    const action = {
      type: 'order',
      orders: [{ a: 1, b: true, p: '2100', s: '0.5', r: false, t: { limit: { tif: 'Ioc' } }, c: cloid }],
      grouping: 'na',
    };
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(actionHash(action, null, BigInt(prepared.nonce)));
    await refusedWith(venue.prepare(account, ownerSigner, order({ type: 'market', timeInForce: 'ALO' })), 'not_offered');
  });

  it('price and size follow the venue rules, refused before signing and never rounded', async () => {
    const venue = venueWith(fakeVenue());
    // ETH perp: szDecimals 4, so at most 2 price decimals and 5 significant figures.
    await refusedWith(venue.prepare(account, ownerSigner, order({ amount: a('0.12345') })), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, order({ price: a('2000.123') })), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, order({ price: a('1234.56') })), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, order({ amount: ZERO })), 'venue_rejected');
    // A whole-number price is always allowed, whatever its significant figures.
    await expect(venue.prepare(account, ownerSigner, order({ price: a('123456') }))).resolves.toBeDefined();
    await expect(venue.prepare(account, ownerSigner, order({ price: a('1234.5') }))).resolves.toBeDefined();
    // Spot PURR: szDecimals 0, so up to 8 price decimals but still 5 significant figures.
    await expect(
      venue.prepare(account, ownerSigner, order({ symbol: 'PURR-USDC', amount: a('10'), price: a('0.12345') })),
    ).resolves.toBeDefined();
    await refusedWith(
      venue.prepare(account, ownerSigner, order({ symbol: 'PURR-USDC', amount: a('10'), price: a('0.123456') })),
      'venue_rejected',
    );
    await refusedWith(venue.prepare(account, ownerSigner, order({ symbol: 'PURR-USDC', amount: a('10.5') })), 'venue_rejected');
  });

  it('refuses an unknown market, a non-business key, and a builder fee the account has not approved', async () => {
    const venue = venueWith(fakeVenue());
    await refusedWith(venue.prepare(account, ownerSigner, order({ symbol: 'DOGE-PERP' })), 'unknown_market');
    await refusedWith(
      venue.prepare(account, ownerSigner, order({ clientOrderKey: '3f2b8c1e-0000-4000-8000-000000000000' })),
      'invalid_client_order_key',
    );
    await refusedWith(
      venue.prepare(account, ownerSigner, order({ builderFee: { builder: BUILDER, feeBps: a('2') } })),
      'builder_fee_not_approved',
    );
    await refusedWith(venue.prepare(account, ownerSigner, order({ builderFee: { builder: BUILDER, feeBps: a('0.05') } })), 'not_offered');
  });

  it('an agent: refused when the venue does not list it, refused owner-only actions', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    await expect(venue.prepare(account, agentSigner, order())).resolves.toBeDefined();
    fake.info.extraAgents = () => [];
    await refusedWith(venue.prepare(account, agentSigner, order()), 'signer_not_authorised');
    fake.info.extraAgents = () => [{ name: 'TEST bot', address: AGENT, validUntil: NOW - 1 }];
    await refusedWith(venue.prepare(account, agentSigner, order()), 'signer_not_authorised');
    const withdraw: VenueIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: OWNER,
      withdrawalKey: 'withdraw:test-user:1',
    };
    await refusedWith(venue.prepare(account, agentSigner, withdraw), 'agent_not_permitted');
    await refusedWith(
      venue.prepare(account, { role: 'owner', address: strangerKey.address.toLowerCase() }, order()),
      'signer_not_authorised',
    );
  });

  it('update_leverage: whole leverage within the market maximum, isolated-only markets refuse cross', async () => {
    const venue = venueWith(fakeVenue());
    const lev = (symbol: string, leverageBps: number, marginMode: 'cross' | 'isolated' = 'cross'): VenueIntent => ({
      kind: 'update_leverage',
      symbol,
      leverageBps,
      marginMode,
    });
    const prepared = await venue.prepare(account, agentSigner, lev('ETH-PERP', 100_000, 'isolated'));
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(
      actionHash({ type: 'updateLeverage', asset: 1, isCross: false, leverage: 10 }, null, BigInt(prepared.nonce)),
    );
    await refusedWith(venue.prepare(account, ownerSigner, lev('ETH-PERP', 105_000)), 'not_offered');
    await refusedWith(venue.prepare(account, ownerSigner, lev('ETH-PERP', 260_000)), 'not_offered');
    await refusedWith(venue.prepare(account, ownerSigner, lev('ISO-PERP', 20_000, 'cross')), 'not_offered');
    await refusedWith(venue.prepare(account, ownerSigner, lev('PURR-USDC', 20_000)), 'not_offered');
  });

  it('withdraw3: user-signed on the testnet chain, the perp account USDC from the main account only', async () => {
    const venue = venueWith(fakeVenue());
    const withdraw = {
      kind: 'withdraw',
      asset: PERP_COLLATERAL_ASSET,
      amount: a('12.5'),
      destination: OWNER,
      withdrawalKey: 'withdraw:test-user:2',
    } as const;
    const prepared = await venue.prepare(account, ownerSigner, withdraw);
    const typed = prepared.typedData as UserSignedTypedData;
    expect(typed.primaryType).toBe('HyperliquidTransaction:Withdraw');
    expect(typed.domain.chainId).toBe(0x66eee);
    expect(typed.message).toEqual({ hyperliquidChain: 'Testnet', destination: OWNER, amount: '12.5', time: BigInt(NOW) });
    expect(prepared.venueClientOrderId).toBeNull();
    await refusedWith(
      venue.prepare({ ...account, subAccount: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' }, ownerSigner, withdraw),
      'not_offered',
    );
    await refusedWith(venue.prepare(account, ownerSigner, { ...withdraw, asset: 'PURR' }), 'not_offered');
    // withdraw3 draws on the perp account: spot USDC (reported by balances() as `USDC`) is a different balance, refused.
    await refusedWith(venue.prepare(account, ownerSigner, { ...withdraw, asset: 'USDC' }), 'not_offered');
    await refusedWith(venue.prepare(account, ownerSigner, { ...withdraw, amount: a('1.0000001') }), 'venue_rejected');
  });

  it('approveBuilderFee and approveAgent: the testnet typed data; an agent expiry, revoke and amend refuse', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const fee = await venue.prepare(account, ownerSigner, { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('1') });
    expect((fee.typedData as UserSignedTypedData).message).toEqual({
      hyperliquidChain: 'Testnet',
      maxFeeRate: '0.01%',
      builder: BUILDER,
      nonce: BigInt(NOW),
    });
    const agent = await venue.prepare(account, ownerSigner, {
      kind: 'approve_agent',
      agentAddress: AGENT,
      agentName: 'TEST bot',
      validUntil: null,
    });
    expect((agent.typedData as UserSignedTypedData).primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    await venue.submit(agent, await sign(ownerKey, agent));
    expect(fake.exchangeBodies[0]!.action).toEqual({
      type: 'approveAgent',
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Testnet',
      agentAddress: AGENT,
      agentName: 'TEST bot',
      nonce: Number(agent.nonce),
    });
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'approve_agent', agentAddress: AGENT, agentName: 'x', validUntil: new Date(NOW + 1) }),
      'not_offered',
    );
    await refusedWith(venue.prepare(account, ownerSigner, { kind: 'revoke_agent', agentAddress: AGENT }), 'not_offered');
    await refusedWith(
      venue.prepare(account, ownerSigner, {
        kind: 'amend_order',
        symbol: 'ETH-PERP',
        clientOrderKey: 'order:test-user:desk:1',
        amount: a('1'),
        price: a('1'),
      }),
      'not_offered',
    );
  });
});

describe('submit verifies before anything is sent', () => {
  it('a signature from another key, an edited intent, or a relabelled signer sends nothing', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, order());
    const forged = await sign(strangerKey, prepared);
    await refusedWith(venue.submit(prepared, { ...forged, signedBy: OWNER }), 'signature_mismatch');
    const edited = { ...prepared, intent: order({ amount: a('5') }) };
    await refusedWith(venue.submit(edited, await sign(ownerKey, prepared)), 'signature_mismatch');
    const withdraw = await venue.prepare(account, ownerSigner, {
      kind: 'withdraw',
      asset: PERP_COLLATERAL_ASSET,
      amount: a('1'),
      destination: OWNER,
      withdrawalKey: 'withdraw:test-user:3',
    });
    const relabelled = { ...withdraw, signer: agentSigner };
    await refusedWith(venue.submit(relabelled, await sign(agentKey, relabelled)), 'agent_not_permitted');
    expect(fake.exchangeBodies).toEqual([]);
  });
});

describe('outcome classification', () => {
  async function submitWith(answer: Answer, intent: VenueIntent = order()) {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, intent);
    fake.exchange.push(answer);
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(fake.exchangeBodies.length).toBe(1);
    return { outcome, fake, prepared };
  }

  it('lost answers are not definite: timeout, dropped connection, dropped body, 5xx, 429, unreadable body', async () => {
    expect((await submitWith('timeout')).outcome).toEqual({ definite: false, reason: 'timeout' });
    expect((await submitWith('drop')).outcome).toEqual({ definite: false, reason: 'connection_lost' });
    expect((await submitWith('drop-body')).outcome).toEqual({ definite: false, reason: 'connection_lost' });
    expect((await submitWith({ status: 502, body: 'bad gateway' })).outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
    expect((await submitWith({ status: 429, body: 'slow down' })).outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
    expect((await submitWith({ status: 200, body: '<html>' })).outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
    expect(
      (await submitWith({ status: 200, body: JSON.stringify({ status: 'ok', response: { type: 'order', data: {} } }) })).outcome,
    ).toEqual({
      definite: false,
      reason: 'venue_error_after_send',
    });
  });

  it('a lost answer is read back by the cloid, and the order is there once', async () => {
    const { outcome, fake, prepared } = await submitWith('timeout');
    expect(outcome.definite).toBe(false);
    const venue = venueWith(fake);
    const read = await venue.orderByClientId(account, prepared.venueClientOrderId!);
    expect(read.value?.venueClientOrderId).toBe(prepared.venueClientOrderId);
    expect(read.value?.status).toBe('open');
  });

  it('the duplicate-nonce answer and a duplicate cloid are "already submitted", never a definite refusal', async () => {
    expect((await submitWith(err('Invalid nonce: duplicate nonce 1794182400000'))).outcome).toEqual({
      definite: false,
      reason: 'already_submitted',
    });
    expect((await submitWith(orderStatus({ error: 'Duplicate cloid' }))).outcome).toEqual({ definite: false, reason: 'already_submitted' });
  });

  it('a nonce outside the window is a definite nonce_rejected: the venue did not apply it', async () => {
    for (const text of ['Invalid nonce: nonce too low 1794000000000', 'Invalid nonce: nonce too high 1799999999999']) {
      const { outcome } = await submitWith(err(text));
      expect(outcome.definite && !outcome.accepted ? outcome.refusal : null).toMatchObject({ code: 'nonce_rejected', detail: text });
    }
  });

  it('stated venue refusals map to typed codes and keep the venue words', async () => {
    const code = async (answer: Answer) => {
      const { outcome } = await submitWith(answer);
      if (!outcome.definite || outcome.accepted) throw new Error('expected a definite refusal');
      expect(outcome.refusal.detail.length).toBeGreaterThan(0);
      return outcome.refusal.code;
    };
    expect(await code(orderStatus({ error: 'Insufficient margin to place order. asset=1' }))).toBe('insufficient_balance');
    expect(await code(orderStatus({ error: 'Insufficient spot balance asset=10000' }))).toBe('insufficient_balance');
    expect(await code(orderStatus({ error: 'Builder fee has not been approved.' }))).toBe('builder_fee_not_approved');
    expect(await code(err('User or API Wallet 0xabc does not exist.'))).toBe('signer_not_authorised');
    expect(await code(orderStatus({ error: 'Order must have minimum value of $10.' }))).toBe('venue_rejected');
  });

  it('a 4xx after the bytes went out is never a refusal: 403, 408, 409, 422 and 429 are read back', async () => {
    for (const status of [400, 403, 408, 409, 422, 429]) {
      const { outcome } = await submitWith({ status, body: status === 422 ? 'Failed to deserialize the JSON body' : 'proxy said no' });
      expect(outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
    }
  });

  it('a resting order is accepted with the venue oid and the order read back', async () => {
    const { outcome, prepared } = await submitWith(orderStatus({ resting: { oid: 77 } }));
    if (!outcome.definite || !outcome.accepted) throw new Error('expected accepted');
    expect(outcome.venueRef).toBe('77');
    expect(outcome.order?.venueClientOrderId).toBe(prepared.venueClientOrderId);
  });

  it('a repeat cancel reports the order cancelled; a cancel of a filled order is order_final; of none, unknown_order', async () => {
    const cancel: VenueIntent = { kind: 'cancel_order', symbol: 'ETH-PERP', clientOrderKey: 'order:test-user:desk:1' };
    const goneText = 'Order was never placed, already canceled, or filled.';
    const withStatus = async (status: string | null) => {
      const fake = fakeVenue();
      const base = fake.info.orderStatus!;
      fake.info.orderStatus = (b) => {
        if (status === null) return { status: 'unknownOid' };
        const r = base(b) as { order: { status: string } };
        r.order.status = status;
        return r;
      };
      const venue = venueWith(fake);
      const prepared = await venue.prepare(account, ownerSigner, cancel);
      expect((prepared.typedData as L1TypedData).message.connectionId).toBe(
        actionHash({ type: 'cancelByCloid', cancels: [{ asset: 1, cloid: prepared.venueClientOrderId! }] }, null, BigInt(prepared.nonce)),
      );
      fake.exchange.push(orderStatus({ error: goneText }));
      return venue.submit(prepared, await sign(ownerKey, prepared));
    };
    const repeat = await withStatus('canceled');
    expect(repeat.definite && repeat.accepted && repeat.order?.status).toBe('canceled');
    const filled = await withStatus('filled');
    expect(!filled.definite || filled.accepted ? null : filled.refusal.code).toBe('order_final');
    const none = await withStatus(null);
    expect(!none.definite || none.accepted ? null : none.refusal.code).toBe('unknown_order');
  });

  it('a cancel the venue answered "success" is accepted, even when the read-back finds nothing yet', async () => {
    const fake = fakeVenue();
    fake.info.orderStatus = () => ({ status: 'unknownOid' });
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, {
      kind: 'cancel_order',
      symbol: 'ETH-PERP',
      clientOrderKey: 'order:test-user:desk:1',
    });
    fake.exchange.push(ok({ type: 'cancel', data: { statuses: ['success'] } }));
    expect(await venue.submit(prepared, await sign(ownerKey, prepared))).toEqual({
      definite: true,
      accepted: true,
      venueRef: null,
      order: null,
      asOf: new Date(NOW),
    });
  });
});

describe('reads: the venue record, decimal strings to scaled bigints', () => {
  it('balances: spot free is total less hold; the perp account apart, as the venue reports it', async () => {
    const fake = fakeVenue();
    fake.info.clearinghouseState = () => ({
      marginSummary: { accountValue: '1000.5' },
      withdrawable: '800.25',
      assetPositions: [],
      time: NOW,
    });
    fake.info.spotClearinghouseState = () => ({ balances: [{ coin: 'USDC', token: 0, total: '50.1', hold: '10', entryNtl: '0' }] });
    const b = await venueWith(fake).balances(account);
    expect(b.value).toEqual([
      { asset: 'USDC', free: a('40.1'), locked: a('10'), total: a('50.1') },
      { asset: PERP_COLLATERAL_ASSET, free: a('800.25'), locked: a('200.25'), total: a('1000.5') },
    ]);
    expect(b.asOf.getTime()).toBe(NOW);
  });

  it('a JSON number where money belongs is refused, never read as a float', async () => {
    const fake = fakeVenue();
    fake.info.clearinghouseState = () => ({ marginSummary: { accountValue: 1000.5 }, withdrawable: '1', assetPositions: [] });
    fake.info.spotClearinghouseState = () => ({ balances: [] });
    await expect(venueWith(fake).balances(account)).rejects.toThrow(/not a string/);
  });

  it('an unknown cloid is a confirmed miss; the venue status words map, an unknown word is loud', async () => {
    const fake = fakeVenue();
    fake.info.orderStatus = () => ({ status: 'unknownOid' });
    expect((await venueWith(fake).orderByClientId(account, '0x' + '0'.repeat(32))).value).toBeNull();
    expect(mapOrderStatus('marginCanceled')).toBe('canceled');
    expect(mapOrderStatus('perpMarginRejected')).toBe('rejected');
    expect(mapOrderStatus('triggered')).toBe('open');
    expect(() => mapOrderStatus('somethingNew')).toThrow();
  });

  it('open orders: a spot buy holds its notional; a perp order its margin at the account leverage', async () => {
    const fake = fakeVenue();
    fake.info.frontendOpenOrders = () => [
      { coin: 'PURR/USDC', side: 'B', limitPx: '0.2', sz: '100', origSz: '100', oid: 1, tif: 'Gtc', orderType: 'Limit', reduceOnly: false },
      {
        coin: 'ETH',
        side: 'A',
        limitPx: '2000',
        sz: '0.5',
        origSz: '1',
        oid: 2,
        cloid: '0xABC',
        tif: 'Alo',
        orderType: 'Limit',
        reduceOnly: false,
      },
      { coin: 'ETH', side: 'B', limitPx: '1900', sz: '0.1', origSz: '0.1', oid: 3, tif: 'Gtc', orderType: 'Limit', reduceOnly: true },
    ];
    const open = (await venueWith(fake).openOrders(account)).value;
    expect(open.map((o) => [o.symbol, o.status, o.locked, o.lockedAsset, o.timeInForce])).toEqual([
      ['PURR-USDC', 'open', a('20'), 'USDC', 'GTC'],
      ['ETH-PERP', 'partially_filled', a('100'), PERP_COLLATERAL_ASSET, 'ALO'],
      ['ETH-PERP', 'open', ZERO, PERP_COLLATERAL_ASSET, 'GTC'],
    ]);
    expect(open[1]!.venueClientOrderId).toBe('0xabc');
    expect(open[0]!.venueClientOrderId).toBeNull();
  });

  it('fills: the builder fee is its own line, realised result only on a closing perp fill', async () => {
    const fake = fakeVenue();
    fake.info.userFillsByTime = () => [
      {
        coin: 'ETH',
        px: '2000',
        sz: '0.5',
        side: 'B',
        time: NOW,
        dir: 'Open Long',
        closedPnl: '0.0',
        oid: 2,
        crossed: true,
        fee: '0.4',
        builderFee: '0.05',
        tid: 9001,
        feeToken: 'USDC',
        cloid: '0xAA',
      },
      {
        coin: 'ETH',
        px: '2100',
        sz: '0.5',
        side: 'A',
        time: NOW + 1,
        dir: 'Close Long',
        closedPnl: '50.0',
        oid: 3,
        crossed: false,
        fee: '0.1',
        tid: 9002,
        feeToken: 'USDC',
      },
    ];
    const fills = (await venueWith(fake).fills(account, new Date(NOW))).value;
    expect(fills.map((f) => [f.fillId, f.role, f.venueFee, f.builderFee, f.realisedPnl, f.venueClientOrderId])).toEqual([
      ['9001', 'taker', a('0.35'), a('0.05'), null, '0xaa'],
      ['9002', 'maker', a('0.1'), ZERO, a('50'), null],
    ]);
  });

  it('positions: the venue mark price, margin and liquidation price or "not known"', async () => {
    const fake = fakeVenue();
    fake.info.clearinghouseState = () => ({
      marginSummary: { accountValue: '0' },
      withdrawable: '0',
      time: NOW,
      assetPositions: [
        {
          position: {
            coin: 'ETH',
            szi: '-0.5',
            entryPx: '2000',
            unrealizedPnl: '-5',
            marginUsed: '100',
            liquidationPx: null,
            leverage: { type: 'isolated', value: 10 },
          },
        },
      ],
    });
    fake.info.metaAndAssetCtxs = () => [META, [{ markPx: '60000' }, { markPx: '2010' }, { markPx: '1' }]];
    const [p] = (await venueWith(fake).positions(account)).value;
    expect(p).toEqual({
      symbol: 'ETH-PERP',
      side: 'short',
      size: a('0.5'),
      entryPrice: a('2000'),
      markPrice: a('2010'),
      unrealisedPnl: a('-5'),
      marginMode: 'isolated',
      margin: a('100'),
      leverageBps: 100_000,
      liquidationPrice: { known: false },
    });
  });

  it('a withdrawal by its nonce, with the venue fee; a miss is null', async () => {
    const fake = fakeVenue();
    fake.info.userNonFundingLedgerUpdates = () => [
      { time: NOW + 5, hash: '0x01', delta: { type: 'deposit', usdc: '100' } },
      { time: NOW + 9, hash: '0x02', delta: { type: 'withdraw', usdc: '12.5', nonce: NOW, fee: '1' } },
    ];
    const venue = venueWith(fake);
    const w = (await venue.withdrawal(account, String(NOW))).value;
    expect(w).toEqual({
      nonce: String(NOW),
      asset: PERP_COLLATERAL_ASSET,
      amount: a('12.5'),
      // This instance never sent it, and the venue's ledger names no destination: honestly unknown.
      destination: null,
      status: 'pending',
      fee: { known: true, value: a('1') },
    });
    expect((await venue.withdrawal(account, String(NOW + 1))).value).toBeNull();
  });

  it('builder approval in tenths of a bp, agents with their expiry, leverage from the venue', async () => {
    const venue = venueWith(fakeVenue());
    expect((await venue.builderFeeApproval(account, BUILDER)).value).toBe(a('1'));
    expect((await venue.agents(account)).value).toEqual([{ address: AGENT, name: 'TEST bot', validUntil: new Date(NOW + 86_400_000) }]);
    expect((await venue.leverage(account, 'ETH-PERP')).value).toEqual({ symbol: 'ETH-PERP', leverageBps: 100_000, marginMode: 'cross' });
  });

  it('a read that cannot reach the venue is venue_down', async () => {
    const fake = fakeVenue();
    fake.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await refusedWith(venueWith(fake).markets(null), 'venue_down');
  });

  it('markets: lot and tick from szDecimals, fees "not known" without an account', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => ({ userCrossRate: '0.00035', userAddRate: '0.0001' });
    const venue = venueWith(fake);
    const anon = (await venue.markets(null)).value;
    const eth = anon.find((m) => m.symbol === 'ETH-PERP')!;
    expect([eth.lotSize, eth.tickSize, eth.maxLeverageBps, eth.takerFeeBps]).toEqual([a('0.0001'), a('0.01'), 250_000, { known: false }]);
    expect(anon.find((m) => m.symbol === 'ISO-PERP')!.marginModes).toEqual(['isolated']);
    const mine = (await venue.markets(account)).value.find((m) => m.symbol === 'ETH-PERP')!;
    expect([mine.takerFeeBps, mine.makerFeeBps]).toEqual([
      { known: true, value: a('3.5') },
      { known: true, value: a('1') },
    ]);
    expect((await venue.markets(account)).value.find((m) => m.symbol === 'PURR-USDC')!.takerFeeBps).toEqual({ known: false });
  });
});

describe('review fixes: nonces, listing, symbols, paging, marks, destinations', () => {
  it('two instances sharing one nonce source never collide in the same millisecond', async () => {
    const shared = new InMemoryNonceSource();
    const fake = fakeVenue();
    const one = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(NOW), nonceSource: shared });
    const two = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(NOW), nonceSource: shared });
    const nonces: string[] = [];
    for (let i = 0; i < 5; i++) {
      nonces.push((await one.prepare(account, ownerSigner, order())).nonce);
      nonces.push((await two.prepare(account, ownerSigner, order())).nonce);
    }
    expect(new Set(nonces).size).toBe(nonces.length);
    // A caller-supplied source is used as given (for example one backed by a shared store).
    const fixed: HyperliquidNonceSource = { next: async () => '1794182400123' };
    const three = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(NOW), nonceSource: fixed });
    expect((await three.prepare(account, ownerSigner, order())).nonce).toBe('1794182400123');
  });

  it('the listing refreshes on a miss (bounded), on its TTL, and concurrent first reads share one fetch', async () => {
    const fake = fakeVenue();
    let now = NOW;
    const venue = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(now) });
    const metaReads = () => fake.infoTypes.filter((t) => t === 'meta').length;
    await Promise.all([venue.markets(null), venue.markets(null), venue.markets(null)]);
    expect(metaReads()).toBe(1);
    // A market listed after the first read is found on a miss.
    fake.info.meta = () => ({ universe: [...META.universe, { name: 'DOGE', szDecimals: 0, maxLeverage: 5 }] });
    const doge = await venue.prepare(account, ownerSigner, order({ symbol: 'DOGE-PERP', amount: a('100'), price: a('0.2') }));
    expect((doge.typedData as L1TypedData).message.connectionId).toBe(
      actionHash(
        {
          type: 'order',
          orders: [{ a: 3, b: true, p: '0.2', s: '100', r: false, t: { limit: { tif: 'Gtc' } }, c: doge.venueClientOrderId! }],
          grouping: 'na',
        },
        null,
        BigInt(doge.nonce),
      ),
    );
    expect(metaReads()).toBe(2);
    // A second miss within the interval does not read again.
    await refusedWith(venue.prepare(account, ownerSigner, order({ symbol: 'NOPE-PERP' })), 'unknown_market');
    expect(metaReads()).toBe(2);
    now += 11_000;
    await refusedWith(venue.prepare(account, ownerSigner, order({ symbol: 'NOPE-PERP' })), 'unknown_market');
    expect(metaReads()).toBe(3);
    // A hit inside the TTL does not read; after the TTL it does.
    await venue.markets(null);
    expect(metaReads()).toBe(3);
    now += 5 * 60_000;
    await venue.markets(null);
    expect(metaReads()).toBe(4);
  });

  it('a position in a newly listed market reads, with its own symbol, instead of failing the account', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    await venue.markets(null);
    const universe = [...META.universe, { name: 'DOGE', szDecimals: 0, maxLeverage: 5 }];
    fake.info.meta = () => ({ universe });
    fake.info.clearinghouseState = () => ({
      marginSummary: { accountValue: '0' },
      withdrawable: '0',
      assetPositions: [
        {
          position: {
            coin: 'DOGE',
            szi: '100',
            entryPx: '0.2',
            unrealizedPnl: '1',
            marginUsed: '4',
            liquidationPx: '0.1',
            leverage: { type: 'cross', value: 5 },
          },
        },
      ],
    });
    fake.info.metaAndAssetCtxs = () => [{ universe }, [{ markPx: '60000' }, { markPx: '2010' }, { markPx: '1' }, { markPx: '0.21' }]];
    const [p] = (await venue.positions(account)).value;
    expect([p!.symbol, p!.markPrice]).toEqual(['DOGE-PERP', a('0.21')]);
  });

  it('positions take the mark from the same answer universe, not from the cached listing order', async () => {
    const fake = fakeVenue();
    fake.info.clearinghouseState = () => ({
      marginSummary: { accountValue: '0' },
      withdrawable: '0',
      assetPositions: [
        {
          position: {
            coin: 'ETH',
            szi: '1',
            entryPx: '2000',
            unrealizedPnl: '10',
            marginUsed: '200',
            liquidationPx: null,
            leverage: { type: 'cross', value: 10 },
          },
        },
      ],
    });
    // The contexts answer lists its universe in its own order.
    fake.info.metaAndAssetCtxs = () => [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ markPx: '2010' }, { markPx: '60000' }]];
    const [p] = (await venueWith(fake).positions(account)).value;
    expect(p!.markPrice).toBe(a('2010'));
  });

  it('two spot pairs with one display name get distinct symbols; cancel and fills resolve to the right asset', async () => {
    const fake = fakeVenue();
    fake.info.spotMeta = () => ({
      tokens: [
        { name: 'USDC', szDecimals: 8, index: 0 },
        { name: 'PURR', szDecimals: 0, index: 1 },
        { name: 'TWIN', szDecimals: 0, index: 2 },
        { name: 'TWIN', szDecimals: 1, index: 3 },
      ],
      universe: [
        { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true },
        { name: '@1', tokens: [2, 0], index: 1, isCanonical: false },
        { name: '@2', tokens: [3, 0], index: 2, isCanonical: true },
      ],
    });
    const venue = venueWith(fake);
    const symbols = (await venue.markets(null)).value.map((m) => m.symbol).filter((s) => s.startsWith('TWIN'));
    expect(symbols.sort()).toEqual(['TWIN-USDC', 'TWIN-USDC@1']);
    const cancelOf = async (symbol: string) => {
      const prepared = await venue.prepare(account, ownerSigner, {
        kind: 'cancel_order',
        symbol,
        clientOrderKey: 'order:test-user:twin:1',
      });
      return (prepared.typedData as L1TypedData).message.connectionId;
    };
    const expected = (asset: number, cloid: string, nonce: string) =>
      actionHash({ type: 'cancelByCloid', cancels: [{ asset, cloid }] }, null, BigInt(nonce));
    const cloid = venueClientOrderId(HL_TESTNET_VENUE_ID, 'order:test-user:twin:1');
    const p1 = await venue.prepare(account, ownerSigner, {
      kind: 'cancel_order',
      symbol: 'TWIN-USDC',
      clientOrderKey: 'order:test-user:twin:1',
    });
    expect((p1.typedData as L1TypedData).message.connectionId).toBe(expected(10_002, cloid, p1.nonce));
    const p2 = await venue.prepare(account, ownerSigner, {
      kind: 'cancel_order',
      symbol: 'TWIN-USDC@1',
      clientOrderKey: 'order:test-user:twin:1',
    });
    expect((p2.typedData as L1TypedData).message.connectionId).toBe(expected(10_001, cloid, p2.nonce));
    expect(await cancelOf('TWIN-USDC')).not.toBe(await cancelOf('TWIN-USDC@1'));
    const fill = (coin: string, tid: number) => ({
      coin,
      px: '1',
      sz: '1',
      side: 'B',
      time: NOW,
      dir: 'Buy',
      closedPnl: '0',
      oid: 1,
      crossed: true,
      fee: '0',
      tid,
      feeToken: 'USDC',
    });
    fake.info.userFillsByTime = () => [fill('@1', 1), fill('@2', 2)];
    const fills = (await venue.fills(account, new Date(NOW))).value;
    expect(fills.map((f) => [f.fillId, f.symbol])).toEqual([
      ['1', 'TWIN-USDC@1'],
      ['2', 'TWIN-USDC'],
    ]);
  });

  it('fills page past the venue cap without dropping or repeating fills that share a millisecond', async () => {
    const fake = fakeVenue();
    const fill = (tid: number, time: number) => ({
      coin: 'ETH',
      px: '2000',
      sz: '0.01',
      side: 'B',
      time,
      dir: 'Open Long',
      closedPnl: '0',
      oid: 1,
      crossed: true,
      fee: '0.01',
      tid,
      feeToken: 'USDC',
    });
    // 2050 fills: the last 10 of the first page and 50 more share one millisecond.
    const all = Array.from({ length: 2050 }, (_, i) => fill(i + 1, i < 1990 ? NOW + i : NOW + 1990));
    const starts: number[] = [];
    fake.info.userFillsByTime = (b) => {
      starts.push(Number(b.startTime));
      return all.filter((f) => f.time >= Number(b.startTime)).slice(0, FILLS_PAGE_CAP);
    };
    const fills = (await venueWith(fake).fills(account, new Date(NOW))).value;
    expect(fills.length).toBe(2050);
    expect(new Set(fills.map((f) => f.fillId)).size).toBe(2050);
    expect(fills.at(-1)!.fillId).toBe('2050');
    expect(starts).toEqual([NOW, NOW + 1990]);
  });

  it('a withdrawal reports the destination this instance signed and sent, and USDC-PERP as its asset', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, {
      kind: 'withdraw',
      asset: PERP_COLLATERAL_ASSET,
      amount: a('12.5'),
      destination: OWNER,
      withdrawalKey: 'withdraw:test-user:9',
    });
    await venue.submit(prepared, await sign(ownerKey, prepared));
    fake.info.userNonFundingLedgerUpdates = () => [
      { time: NOW + 9, hash: '0x02', delta: { type: 'withdraw', usdc: '12.5', nonce: Number(prepared.nonce), fee: '1' } },
    ];
    const w = (await venue.withdrawal(account, prepared.nonce)).value!;
    expect([w.asset, w.destination]).toEqual([PERP_COLLATERAL_ASSET, OWNER]);
  });
});
