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
  recoverTypedDataSigner,
  typedDataDigest,
  type HlTypedData,
  type L1TypedData,
  type UserSignedTypedData,
} from './signing.js';
import {
  FILLS_GRID_MS,
  FILLS_PAGE_CAP,
  HL_TESTNET_VENUE_ID,
  HyperliquidTestnetUserVenue,
  InMemoryNonceSource,
  keylessStandIn,
  PERP_COLLATERAL_ASSET,
  mapOrderStatus,
  withCancelReason,
  type FetchLike,
  type HyperliquidNonceSource,
} from './venue.js';
import type { MsgpackValue } from './msgpack.js';
import type { VenueWeightMinute } from './core.js';

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
      predictedFundings: () => [],
      userFees: () => ({}),
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

  it('#11048: a trigger order or one attached to an entry is refused, never sent as a plain order that fills at once', async () => {
    // On the testnet a reduce-only stop 3,000 under the mark went out as a plain IOC and closed the position at once.
    const venue = venueWith(fakeVenue());
    const stop = { price: a('1800'), source: 'mark' as const, role: 'stop_loss' as const };
    const market = { type: 'market' as const, timeInForce: 'IOC' as const, side: 'sell' as const, reduceOnly: true };
    await refusedWith(venue.prepare(account, ownerSigner, order({ ...market, trigger: stop })), 'not_offered');
    await refusedWith(venue.preview(account, order({ ...market, trigger: stop })), 'not_offered');
    await refusedWith(
      venue.prepare(account, ownerSigner, order({ ...market, parentClientOrderKey: 'order:0xabc:entry:1' })),
      'not_offered',
    );
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

  it('#10657: a perp order and a spot sell each carry their own builder fee, each refused above its own protocol cap', async () => {
    const fake = fakeVenue();
    fake.info.maxBuilderFee = () => 10_000; // the trader approved 1000 bps: only the venue's cap binds here
    const venue = venueWith(fake);
    const perp = await venue.prepare(account, ownerSigner, order({ builderFee: { builder: BUILDER, feeBps: a('10') } }));
    expect(perp.builderFee).toEqual({ builder: BUILDER, feeBps: a('10') });
    await refusedWith(
      venue.prepare(account, ownerSigner, order({ builderFee: { builder: BUILDER, feeBps: a('10.1') } })),
      'builder_fee_above_cap',
    );
    const spotSell = order({ symbol: 'PURR-USDC', side: 'sell', amount: a('10'), price: a('0.1') });
    const spot = await venue.prepare(account, ownerSigner, { ...spotSell, builderFee: { builder: BUILDER, feeBps: a('100') } });
    expect(spot.builderFee).toEqual({ builder: BUILDER, feeBps: a('100') });
    await refusedWith(
      venue.prepare(account, ownerSigner, { ...spotSell, builderFee: { builder: BUILDER, feeBps: a('100.1') } }),
      'builder_fee_above_cap',
    );
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
    expect(typed.domain.chainId).toBe(84532);
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

  // The customer's wallet is held on the app chain (Base Sepolia, 84532: apps/customer eip1193.ts APP_CHAIN_ID), and
  // the app's signing sheet refuses a typed-data domain on any other chain before the wallet is asked; a wallet such as
  // MetaMask refuses one too. Hyperliquid takes the chain the action names in `signatureChainId` (the SDK signs under the
  // wallet's own chain when none is set), so every user-signed action is built for the wallet's chain.
  it('user-signed actions are signed under the wallet chain (84532 by default, else the one passed in), and the venue gets that chain', async () => {
    const intents = [
      { kind: 'approve_agent', agentAddress: AGENT, agentName: 'TEST bot', validUntil: null },
      { kind: 'approve_builder_fee', builder: AGENT, maxFeeBps: a('1') },
      { kind: 'withdraw', asset: PERP_COLLATERAL_ASSET, amount: a('12.5'), destination: OWNER, withdrawalKey: 'withdraw:test-user:9' },
    ] as const;
    for (const [walletChainId, hex] of [
      [undefined, '0x14a34'],
      [31337, '0x7a69'],
    ] as const) {
      const fake = fakeVenue();
      const venue = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fake.fetch, clock: () => new Date(NOW), walletChainId });
      expect(venue.chainId).toBe(walletChainId ?? 84532);
      for (const intent of intents) {
        const prepared = await venue.prepare(account, ownerSigner, intent);
        const typed = prepared.typedData as UserSignedTypedData;
        expect(typed.domain.chainId).toBe(walletChainId ?? 84532);
        const signed = await sign(ownerKey, prepared);
        await venue.submit(prepared, signed);
        expect((fake.exchangeBodies.at(-1)!.action as Record<string, unknown>).signatureChainId).toBe(hex);
        expect(await recoverTypedDataSigner(typed, signed.signature)).toBe(OWNER);
      }
    }
    expect(() => new HyperliquidTestnetUserVenue({ appEnv: 'test', walletChainId: 0 })).toThrow(/wallet chain/);
  });

  // Hyperliquid takes an agent's expiry only in its name, `<name> valid_until <ms>`, at most 180 days ahead (exchange
  // endpoint, "Approve an API wallet"); the session key (J-wallet-22 #8) is approved with one.
  it('approveAgent with an expiry signs `<name> valid_until <ms>`, and an expiry past or beyond 180 days refuses', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const until = new Date(NOW + 8 * 3_600_000);
    const agent = await venue.prepare(account, ownerSigner, {
      kind: 'approve_agent',
      agentAddress: AGENT,
      agentName: 'trading-session',
      validUntil: until,
    });
    expect((agent.typedData as UserSignedTypedData).message.agentName).toBe(`trading-session valid_until ${until.getTime()}`);
    await venue.submit(agent, await sign(ownerKey, agent));
    expect((fake.exchangeBodies[0]!.action as Record<string, unknown>).agentName).toBe(`trading-session valid_until ${until.getTime()}`);
    const day = 86_400_000;
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'approve_agent', agentAddress: AGENT, agentName: 'x', validUntil: new Date(NOW - 1) }),
      'venue_rejected',
    );
    await refusedWith(
      venue.prepare(account, ownerSigner, {
        kind: 'approve_agent',
        agentAddress: AGENT,
        agentName: 'x',
        validUntil: new Date(NOW + 181 * day),
      }),
      'not_offered',
    );
    const longest = await venue.prepare(account, ownerSigner, {
      kind: 'approve_agent',
      agentAddress: AGENT,
      agentName: 'x',
      validUntil: new Date(NOW + 179 * day),
    });
    expect((longest.typedData as UserSignedTypedData).message.agentName).toMatch(/^x valid_until \d+$/);
  });

  // The venue has no revoke: an agent is deregistered by approving another under its name ("Nonces and API wallets").
  it("revoke_agent approves, under the agent's own name, a keyless address new to this revoke that lapses in a day", async () => {
    const fake = fakeVenue();
    fake.info.extraAgents = () => [{ name: `trading-session valid_until ${NOW + 3_600_000}`, address: AGENT, validUntil: NOW + 3_600_000 }];
    const venue = venueWith(fake);
    const revoke = await venue.prepare(account, ownerSigner, { kind: 'revoke_agent', agentAddress: AGENT });
    const message = (revoke.typedData as UserSignedTypedData).message;
    expect((revoke.typedData as UserSignedTypedData).primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(message.agentAddress).toBe(keylessStandIn(AGENT, revoke.nonce));
    // A fixed vector: the derivation is keccak256 of the revoked address and the nonce, its last 20 bytes.
    expect(keylessStandIn('0x00000000000000000000000000000000000000a1', '1762646400000')).toBe(
      '0x81ac6ec1caafeda86fe627ea69432025ca9610af',
    );
    expect(message.agentAddress).not.toBe(AGENT);
    expect(message.agentName).toBe(`trading-session valid_until ${Number(revoke.nonce) + 86_400_000}`);
    const outcome = await venue.submit(revoke, await sign(ownerKey, revoke));
    expect(outcome).toMatchObject({ definite: true, accepted: true });
    expect(fake.exchangeBodies[0]!.action).toMatchObject({ type: 'approveAgent', agentAddress: keylessStandIn(AGENT, revoke.nonce) });
    // Sent again after it landed (its answer lost): the stand-in is listed, so it is done, and nothing is posted twice.
    fake.info.extraAgents = () => [
      { name: `trading-session valid_until ${NOW + 86_400_000}`, address: keylessStandIn(AGENT, revoke.nonce), validUntil: null },
    ];
    expect(await venue.submit(revoke, await sign(ownerKey, revoke))).toMatchObject({ definite: true, accepted: true });
    expect(fake.exchangeBodies).toHaveLength(1);
    // ...but only with the owner's own signature over it.
    await refusedWith(venue.submit(revoke, { ...(await sign(strangerKey, revoke)), signedBy: OWNER }), 'signature_mismatch');
    expect(fake.exchangeBodies).toHaveLength(1);
    fake.info.extraAgents = () => [{ name: `trading-session valid_until ${NOW + 3_600_000}`, address: AGENT, validUntil: NOW + 3_600_000 }];
    // A second revoke gets a different stand-in, so no address is ever approved twice.
    const again = await venue.prepare(account, ownerSigner, { kind: 'revoke_agent', agentAddress: AGENT });
    expect((again.typedData as UserSignedTypedData).message.agentAddress).not.toBe(message.agentAddress);
    // The account's one unnamed agent is replaced by an unnamed stand-in, which carries no expiry.
    fake.info.extraAgents = () => [{ name: '', address: AGENT, validUntil: null }];
    const unnamed = await venue.prepare(account, ownerSigner, { kind: 'revoke_agent', agentAddress: AGENT });
    expect((unnamed.typedData as UserSignedTypedData).message.agentName).toBe('');
    await refusedWith(
      venue.prepare({ ...account, subAccount: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' }, ownerSigner, {
        kind: 'revoke_agent',
        agentAddress: AGENT,
      }),
      'not_offered',
    );
    // An agent key can never revoke.
    await refusedWith(venue.prepare(account, agentSigner, { kind: 'revoke_agent', agentAddress: AGENT }), 'agent_not_permitted');
  });

  it('approveBuilderFee and approveAgent: the testnet typed data; a nameless agent and a revoke of no agent refuse', async () => {
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
      signatureChainId: '0x14a34',
      hyperliquidChain: 'Testnet',
      agentAddress: AGENT,
      agentName: 'TEST bot',
      nonce: Number(agent.nonce),
    });
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'approve_agent', agentAddress: AGENT, agentName: ' ', validUntil: null }),
      'venue_rejected',
    );
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'approve_agent', agentAddress: AGENT, agentName: 'x valid_until 1', validUntil: null }),
      'venue_rejected',
    );
    await refusedWith(venue.prepare(account, ownerSigner, { kind: 'revoke_agent', agentAddress: OWNER }), 'venue_rejected');
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'create_sub_account', name: 'TEST sub', subAccountKey: 'sub:owner:1' }),
      'not_offered',
    );
    await refusedWith(
      venue.prepare(account, ownerSigner, {
        kind: 'sub_account_transfer',
        subAccount: '0x00000000000000000000000000000000000000c3',
        direction: 'into_sub_account',
        asset: 'USDC',
        amount: 1n,
        moveKey: 'move:owner:1',
      }),
      'not_offered',
    );
    await refusedWith(
      venue.prepare(account, ownerSigner, { kind: 'cancel_orders', orders: [{ symbol: 'ETH-PERP', venueClientOrderId: '0x01' }] }),
      'not_offered',
    );
  });
});

describe('preview reads the venue and sends nothing', () => {
  const FEES = { userCrossRate: '0.00045', userAddRate: '0.00015', userSpotCrossRate: '0.0007', userSpotAddRate: '0.0004' };
  const book = (bids: Array<[string, string]>, asks: Array<[string, string]>) => () => ({
    coin: 'X',
    time: NOW,
    levels: [bids.map(([px, sz]) => ({ px, sz, n: 1 })), asks.map(([px, sz]) => ({ px, sz, n: 1 }))],
  });

  it('a resting perp buy: maker, its margin at the account leverage, the maker fee and our builder fee; no liquidation price', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => FEES;
    fake.info.l2Book = book([['1990', '3']], [['2010', '3']]);
    const p = (await venueWith(fake).preview(account, order({ builderFee: { builder: BUILDER, feeBps: a('0.5') } }))).value;
    expect(p.role).toBe('maker');
    expect(p.lock).toEqual({ asset: 'USDC-PERP', amount: a('100') });
    expect(p.venueFee).toEqual({ known: true, value: { asset: 'USDC-PERP', amount: a('0.15') } });
    expect(p.builderFee).toEqual({ known: true, value: { asset: 'USDC-PERP', amount: a('0.05') } });
    expect(p.perpetual).toEqual({
      leverageBps: 100_000,
      marginMode: 'cross',
      initialMargin: { known: true, value: a('100') },
      liquidationPrice: { known: false },
    });
    expect(fake.exchangeBodies).toHaveLength(0);
  });

  it('a perp buy that crosses: taker, the met part at the taker rate and its fill prices, the rest at the maker rate', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => FEES;
    // The bids side would be met by a sell, never by this buy.
    fake.info.l2Book = book(
      [['2005', '5']],
      [
        ['1999', '0.2'],
        ['2001', '1'],
      ],
    );
    const p = (await venueWith(fake).preview(account, order())).value;
    expect(p.role).toBe('taker');
    // 0.2 × 1999 = 399.8 at 4.5 bps = 0.17991; 0.3 × 2000 = 600 at 1.5 bps = 0.09.
    expect(p.venueFee).toEqual({ known: true, value: { asset: 'USDC-PERP', amount: a('0.26991') } });
    expect(p.builderFee).toEqual({ known: true, value: { asset: 'USDC-PERP', amount: a('0') } });
    // The book is not walked at this size yet, so what fills now is not known, never zero.
    expect(p.fill).toEqual({ known: false });
  });

  it('a spot buy locks its quote notional and pays the fee in the base it receives; an unpublished rate is not known', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => ({});
    fake.info.l2Book = book([], [['0.21', '1000']]);
    const spot = order({ symbol: 'PURR-USDC', amount: a('100'), price: a('0.2') });
    const p = (await venueWith(fake).preview(account, spot)).value;
    expect(p.kind).toBe('spot');
    expect(p.role).toBe('maker');
    expect(p.lock).toEqual({ asset: 'USDC', amount: a('20') });
    expect(p.venueFee).toEqual({ known: false });
    expect(p.perpetual).toBeNull();
    fake.info.userFees = () => FEES;
    const known = (await venueWith(fake).preview(account, spot)).value;
    expect(known.venueFee).toEqual({ known: true, value: { asset: 'PURR', amount: a('0.04') } });
  });

  it('refuses on its face what prepare refuses, before any book is read', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => FEES;
    fake.info.l2Book = book([], []);
    const v = venueWith(fake);
    await refusedWith(v.preview(account, order({ amount: a('0.12345') })), 'venue_rejected');
    await refusedWith(v.preview(account, order({ symbol: 'PURR-USDC', amount: a('1'), price: a('0.2'), reduceOnly: true })), 'not_offered');
    await refusedWith(v.preview(account, order({ symbol: 'NOPE-PERP' })), 'unknown_market');
    expect(fake.infoTypes).not.toContain('l2Book');
    expect(fake.exchangeBodies).toHaveLength(0);
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

  it('#11051: "User has pending agent removal" is agent_removal_pending, keeping the venue words', async () => {
    const { outcome } = await submitWith(err('User has pending agent removal'));
    if (!outcome.definite || outcome.accepted) throw new Error('expected a definite refusal');
    expect(outcome.refusal.code).toBe('agent_removal_pending');
    expect(outcome.refusal.detail).toBe('User has pending agent removal');
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

  it('a cancel the venue answered "success" never reads back as still open: a read-back that lags leaves the detail to the next read (#11048)', async () => {
    // On the beta (2026-11-27 08:54 UTC) the venue answered the cancel "success" and cancelled the order at 08:54:02.279,
    // but the read-back a moment later still listed it open, so the desk told the tester "Open on the venue." after Cancel.
    // Still open with nothing filled, and still open with part filled (sz under origSz).
    for (const left of ['0.5', '0.2']) {
      const fake = fakeVenue();
      const base = fake.info.orderStatus!;
      fake.info.orderStatus = (b) => {
        const r = base(b) as { order: { order: { sz: string } } };
        r.order.order.sz = left;
        return r;
      };
      const venue = venueWith(fake);
      const prepared = await venue.prepare(account, ownerSigner, {
        kind: 'cancel_order',
        symbol: 'ETH-PERP',
        clientOrderKey: 'order:test-user:desk:1',
      });
      fake.exchange.push(ok({ type: 'cancel', data: { statuses: ['success'] } }));
      const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
      if (!outcome.definite || !outcome.accepted) throw new Error(`expected an accepted cancel, got ${JSON.stringify(outcome)}`);
      expect(outcome.order).toBeNull();
      expect(outcome.venueRef).toBe('77');
    }
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

  it('a self-trade cancel is named as one; any other cancel word leaves the reason unsaid (J-derivatives-04 #7)', () => {
    const order = { venueClientOrderId: '0x1', status: 'canceled', cancelReason: null };
    expect(mapOrderStatus('selfTradeCanceled')).toBe('canceled');
    expect(withCancelReason(order, 'selfTradeCanceled').cancelReason).toBe('self_trade');
    expect(withCancelReason(order, 'marginCanceled')).toBe(order);
    expect(withCancelReason(order, 'canceled')).toBe(order);
  });

  it('order history: every state the venue reports, newest placed first, with when it was placed (J-cex-spot-06 #1)', async () => {
    const fake = fakeVenue();
    const order = (oid: number, sz: string, origSz: string, timestamp: number) => ({
      coin: 'ETH',
      side: 'B',
      limitPx: '2000',
      sz,
      origSz,
      oid,
      cloid: `0x${String(oid).padStart(32, '0')}`,
      tif: 'Gtc',
      orderType: 'Limit',
      reduceOnly: false,
      timestamp,
    });
    fake.info.historicalOrders = () => [
      { order: order(1, '0', '0.5', NOW - 3000), status: 'filled', statusTimestamp: NOW - 2000 },
      { order: order(3, '0.3', '0.5', NOW - 1000), status: 'open', statusTimestamp: NOW - 1000 },
      { order: order(2, '0.5', '0.5', NOW - 2000), status: 'canceled', statusTimestamp: NOW - 1500 },
    ];
    const history = (await venueWith(fake).orderHistory(account)).value;
    expect(fake.infoTypes).toContain('historicalOrders');
    expect(history.map((r) => [r.order.venueOrderId, r.order.status, r.order.filled, r.placedAt.getTime()])).toEqual([
      ['3', 'partially_filled', parseAmount('0.2'), NOW - 1000],
      ['2', 'canceled', ZERO, NOW - 2000],
      ['1', 'filled', parseAmount('0.5'), NOW - 3000],
    ]);
    // A cancelled order locks nothing; the open one still locks its remainder's margin.
    expect(history[1]!.order.locked).toBe(ZERO);
    expect(history.every((r) => r.order.origin === 'user')).toBe(true);
  });

  it('order history maps trigger and liquidation orders to their origin (J-derivatives-04 #2)', async () => {
    const fake = fakeVenue();
    const base = {
      coin: 'ETH',
      side: 'A',
      limitPx: '2900',
      sz: '0',
      origSz: '0.1',
      tif: 'Ioc',
      reduceOnly: true,
      timestamp: NOW,
    };
    fake.info.historicalOrders = () => [
      {
        order: { ...base, oid: 11, cloid: `0x${'1'.repeat(32)}`, orderType: 'Stop Market', isTrigger: true },
        status: 'filled',
        statusTimestamp: NOW,
      },
      {
        order: { ...base, oid: 12, cloid: `0x${'2'.repeat(32)}`, orderType: 'Take Profit Market', isTrigger: true },
        status: 'filled',
        statusTimestamp: NOW,
      },
      {
        order: { ...base, oid: 13, cloid: `0x${'3'.repeat(32)}`, orderType: 'Liquidation', isLiquidation: true },
        status: 'filled',
        statusTimestamp: NOW,
      },
    ];
    const history = (await venueWith(fake).orderHistory(account)).value;
    expect(history.map((r) => [r.order.venueOrderId, r.order.origin])).toEqual([
      ['11', 'stop'],
      ['12', 'take_profit'],
      ['13', 'liquidation'],
    ]);
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
      [`${NOW}:ETH:9001`, 'taker', a('0.35'), a('0.05'), null, '0xaa'],
      [`${NOW + 1}:ETH:9002`, 'maker', a('0.1'), ZERO, a('50'), null],
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
      // The venue reports one fee and no separate network fee: not known, never 0.
      networkFee: { known: false },
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

  it('markets: lot and tick from szDecimals, fees the venue base schedule without an account and its own with one', async () => {
    const fake = fakeVenue();
    fake.info.userFees = (b) =>
      b.user === '0x0000000000000000000000000000000000000000'
        ? { userCrossRate: '0.00045', userAddRate: '0.00015' }
        : { userCrossRate: '0.00035', userAddRate: '0.0001' };
    const venue = venueWith(fake);
    const anon = (await venue.markets(null)).value;
    const eth = anon.find((m) => m.symbol === 'ETH-PERP')!;
    expect([eth.lotSize, eth.tickSize, eth.maxLeverageBps, eth.takerFeeBps, eth.makerFeeBps]).toEqual([
      a('0.0001'),
      a('0.01'),
      250_000,
      { known: true, value: a('4.5') },
      { known: true, value: a('1.5') },
    ]);
    // A schedule that names no rate leaves it not known, never a zero.
    const bare = fakeVenue();
    bare.info.userFees = () => ({});
    const blank = (await venueWith(bare).markets(null)).value.find((m) => m.symbol === 'ETH-PERP')!;
    expect(blank.takerFeeBps).toEqual({ known: false });
    expect(anon.find((m) => m.symbol === 'ISO-PERP')!.marginModes).toEqual(['isolated']);
    const mine = (await venue.markets(account)).value.find((m) => m.symbol === 'ETH-PERP')!;
    expect([mine.takerFeeBps, mine.makerFeeBps]).toEqual([
      { known: true, value: a('3.5') },
      { known: true, value: a('1') },
    ]);
    expect((await venue.markets(account)).value.find((m) => m.symbol === 'PURR-USDC')!.takerFeeBps).toEqual({ known: false });
    // The builder-fee cap is the venue's protocol-wide one by kind: 0.1% on perps, 1% on spot.
    expect(eth.builderFeeCapBps).toEqual({ known: true, value: a('10') });
    expect(anon.find((m) => m.symbol === 'PURR-USDC')!.builderFeeCapBps).toEqual({ known: true, value: a('100') });
    // Smallest order value ($10 / 10 quote) and default open-order cap (1000) are published; price band stays null.
    for (const m of anon) {
      expect([m.minOrderNotional, m.priceBandBps, m.maxOpenOrders]).toEqual([a('10'), null, 1000]);
    }
    // A listed market is trading, as the venue lists it; no largest order is published.
    expect(anon.map((m) => [m.status, m.maxOrderQty, m.maxOrderNotional])).toEqual(anon.map(() => ['trading', null, null]));
  });

  it('a perp the venue flags delisted is not listed at all, so no market it lists is ever drawn trading after delisting', async () => {
    const fake = fakeVenue();
    fake.info.meta = () => ({ universe: [...META.universe, { name: 'OLD', szDecimals: 2, maxLeverage: 3, isDelisted: true }] });
    const listed = (await venueWith(fake).markets(null)).value.map((m) => [m.symbol, m.status]);
    expect(listed).not.toContainEqual(['OLD-PERP', 'trading']);
    expect(listed.map(([s]) => s)).not.toContain('OLD-PERP');
    expect(listed).toContainEqual(['BTC-PERP', 'trading']);
  });

  // The contract strip (J-derivatives-01 #4) carries what the venue publishes for a perpetual, never "not published":
  // one contract is one unit of the coin, the mark is `metaAndAssetCtxs`' `markPx` and
  // the funding is `predictedFundings`' own `HlPerp` entry (rate, interval, next payment).
  it('markets: a perp carries the venue contract size, mark and funding; a coin it publishes no funding for, and spot, stay not known', async () => {
    const fake = fakeVenue();
    fake.info.metaAndAssetCtxs = () => [
      META,
      [{ markPx: '62620', funding: '0.0000125' }, { markPx: '2010', funding: '0.00001' }, { markPx: '1' }],
    ];
    const next = NOW + 1_800_000;
    fake.info.predictedFundings = () => [
      [
        'BTC',
        [
          ['BinPerp', { fundingRate: '-0.0002', nextFundingTime: NOW + 7_200_000, fundingIntervalHours: 8 }],
          ['HlPerp', { fundingRate: '0.0000125', nextFundingTime: next, fundingIntervalHours: 1 }],
        ],
      ],
      ['ETH', [['BinPerp', { fundingRate: '0.0001', nextFundingTime: next, fundingIntervalHours: 8 }]]],
    ];
    const list = (await venueWith(fake).markets(null)).value;
    const btc = list.find((m) => m.symbol === 'BTC-PERP')!;
    expect([btc.contractSize, btc.mark]).toEqual([
      { known: true, value: a('1') },
      { known: true, value: a('62620') },
    ]);
    expect(btc.funding).toEqual({ known: true, value: { rate: a('0.0000125'), intervalSeconds: 3600, nextFundingAt: new Date(next) } });
    const eth = list.find((m) => m.symbol === 'ETH-PERP')!;
    expect([eth.mark, eth.funding]).toEqual([{ known: true, value: a('2010') }, { known: false }]);
    const purr = list.find((m) => m.symbol === 'PURR-USDC')!;
    expect([purr.contractSize, purr.mark, purr.funding]).toEqual([{ known: false }, { known: false }, { known: false }]);
  });

  it('markets: a failed mark or funding read leaves those figures not known and the listing up', async () => {
    const fake = fakeVenue();
    const list = (await venueWith(fake).markets(null)).value;
    const btc = list.find((m) => m.symbol === 'BTC-PERP')!;
    expect([btc.status, btc.mark, btc.funding]).toEqual(['trading', { known: false }, { known: false }]);
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
      [`${NOW}:@1:1`, 'TWIN-USDC@1'],
      [`${NOW}:@2:2`, 'TWIN-USDC'],
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
    expect(fills.at(-1)!.fillId).toBe(`${NOW + 1990}:ETH:2050`);
    expect(starts).toEqual([NOW, NOW + 1990]);
  });

  it('two trades on different coins with the same trade id on one account are two fills, each with its own id (D6, test 3)', async () => {
    const fake = fakeVenue();
    const fill = (coin: string, builderFee: string) => ({
      coin,
      px: '2000',
      sz: '0.5',
      side: 'B',
      time: NOW,
      dir: 'Open Long',
      closedPnl: '0',
      oid: 7,
      crossed: true,
      fee: '0.4',
      builderFee,
      tid: 4242,
      feeToken: 'USDC',
    });
    fake.info.userFillsByTime = () => [fill('ETH', '0.05'), fill('BTC', '0.07')];
    const fills = (await venueWith(fake).fills(account, new Date(NOW))).value;
    expect(fills.map((f) => [f.fillId, f.symbol, f.builderFee])).toEqual([
      [`${NOW}:BTC:4242`, 'BTC-PERP', a('0.07')],
      [`${NOW}:ETH:4242`, 'ETH-PERP', a('0.05')],
    ]);
  });

  it('a fill id keeps a coin that holds a colon whole, and the same fill read on two pages is one fill', async () => {
    const fake = fakeVenue();
    const f = {
      coin: 'xyz:GOLD',
      px: '1',
      sz: '1',
      side: 'B',
      time: NOW,
      dir: 'Buy',
      closedPnl: '0',
      oid: 1,
      crossed: true,
      fee: '0',
      tid: 5,
      feeToken: 'USDC',
    };
    fake.info.userFillsByTime = () => [f, { ...f }];
    const fills = (await venueWith(fake).fills(account, new Date(NOW))).value;
    expect(fills.map((x) => x.fillId)).toEqual([`${NOW}:xyz:GOLD:5`]);
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
    // The venue reports no separate network fee for the bridge's send: not known, never 0.
    expect(w.networkFee).toEqual({ known: false });
  });
});

describe('book reads for the hand-run tools', () => {
  it('l2Book reads the market by its venue coin and returns scaled bigints, best first', async () => {
    const fake = fakeVenue();
    let asked: unknown;
    fake.info.l2Book = (b) => {
      asked = b.coin;
      return {
        coin: 'PURR/USDC',
        time: NOW,
        levels: [
          [
            { px: '0.2001', sz: '100', n: 1 },
            { px: '0.2', sz: '5', n: 2 },
          ],
          [{ px: '0.2005', sz: '7', n: 1 }],
        ],
      };
    };
    const book = await venueWith(fake).l2Book('PURR-USDC');
    expect(asked).toBe('PURR/USDC');
    expect(book.value).toEqual({
      symbol: 'PURR-USDC',
      bids: [
        { price: a('0.2001'), size: a('100') },
        { price: a('0.2'), size: a('5') },
      ],
      asks: [{ price: a('0.2005'), size: a('7') }],
    });
    expect(book.asOf.getTime()).toBe(NOW);
  });

  it('l2Book of an unknown symbol is refused unknown_market', async () => {
    await expect(venueWith(fakeVenue()).l2Book('NOPE-USDC')).rejects.toMatchObject({ refusal: { code: 'unknown_market' } });
  });

  it('book (UserVenue) is the top depth levels of l2Book as price and amount, best first, with its venue time', async () => {
    const fake = fakeVenue();
    fake.info.l2Book = () => ({
      coin: 'PURR/USDC',
      time: NOW,
      levels: [
        [
          { px: '0.2001', sz: '100', n: 1 },
          { px: '0.2', sz: '5', n: 2 },
        ],
        [
          { px: '0.2005', sz: '7', n: 1 },
          { px: '0.201', sz: '9', n: 1 },
        ],
      ],
    });
    const book = await venueWith(fake).book('PURR-USDC', 1);
    expect(book.value).toEqual({
      symbol: 'PURR-USDC',
      bids: [{ price: a('0.2001'), amount: a('100') }],
      asks: [{ price: a('0.2005'), amount: a('7') }],
    });
    expect(book.asOf.getTime()).toBe(NOW);
    expect(book.venueId).toBe(HL_TESTNET_VENUE_ID);
    expect((await venueWith(fake).book('PURR-USDC', 5)).value.asks).toHaveLength(2);
  });

  it('book of an unknown symbol is refused unknown_market, and a depth below 1 is refused before any read', async () => {
    await expect(venueWith(fakeVenue()).book('NOPE-USDC', 5)).rejects.toMatchObject({ refusal: { code: 'unknown_market' } });
    const fake = fakeVenue();
    await expect(venueWith(fake).book('PURR-USDC', 0)).rejects.toThrow(RangeError);
    expect(fake.infoTypes).not.toContain('l2Book');
  });

  it('mids maps coins to our symbols and leaves out coins we do not list', async () => {
    const fake = fakeVenue();
    fake.info.allMids = () => ({ ETH: '2000.5', 'PURR/USDC': '0.2003', '@999': '1' });
    const mids = (await venueWith(fake).mids()).value;
    expect([...mids.entries()].sort()).toEqual([
      ['ETH-PERP', a('2000.5')],
      ['PURR-USDC', a('0.2003')],
    ]);
  });
});

describe('feeStatus reads userFees and sends nothing (J-cex-spot-10 #2 #6)', () => {
  const USER_FEES = {
    dailyUserVlm: [
      { date: '2026-11-16', userCross: '1000.5', userAdd: '200', exchange: '1' },
      { date: '2026-11-17', userCross: '0', userAdd: '50', exchange: '1' },
    ],
    feeSchedule: {
      cross: '0.00045',
      add: '0.00015',
      spotCross: '0.0007',
      spotAdd: '0.0004',
      tiers: { vip: [{ ntlCutoff: '5000000.0', cross: '0.0004', add: '0.00012', spotCross: '0.0006', spotAdd: '0.0003' }], mm: [] },
    },
    userCrossRate: '0.00045',
    userAddRate: '0.00015',
    userSpotCrossRate: '0.0007',
    userSpotAddRate: '-0.00001',
  };
  const bps = (v: string) => ({ known: true, value: a(v) });

  it("the tiers from the base and feeSchedule.tiers.vip, the account's summed daily volume and its own rates", async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => USER_FEES;
    const s = (await venueWith(fake).feeStatus(account)).value;
    expect(s.schedule.tiers).toEqual([
      {
        name: 'Tier 0',
        fromVolume: a('0'),
        spot: { makerFeeBps: bps('4'), takerFeeBps: bps('7') },
        perpetual: { makerFeeBps: bps('1.5'), takerFeeBps: bps('4.5') },
      },
      {
        name: 'Tier 1',
        fromVolume: a('5000000'),
        spot: { makerFeeBps: bps('3'), takerFeeBps: bps('6') },
        perpetual: { makerFeeBps: bps('1.2'), takerFeeBps: bps('4') },
      },
    ]);
    expect(s.account).toEqual({
      tierName: null,
      volume: bps('1250.5'),
      spot: { makerFeeBps: bps('-0.1'), takerFeeBps: bps('7') },
      perpetual: { makerFeeBps: bps('1.5'), takerFeeBps: bps('4.5') },
      tierUpdatedAt: null,
    });
    expect(fake.exchangeBodies).toHaveLength(0);
  });

  it('with no account, the schedule alone; a venue that sends no schedule publishes no tiers', async () => {
    const fake = fakeVenue();
    fake.info.userFees = () => ({});
    const s = (await venueWith(fake).feeStatus(null)).value;
    expect(s).toEqual({ schedule: { tiers: null, volumeAsset: 'USDC', volumeDays: 14 }, account: null });
  });
});

describe("public market data: best prices, prints and candles, no account (the desks' book, tape and chart)", () => {
  const book = (bids: [string, string][], asks: [string, string][]) => () => ({
    coin: 'BTC',
    time: NOW,
    levels: [bids.map(([px, sz]) => ({ px, sz, n: 1 })), asks.map(([px, sz]) => ({ px, sz, n: 1 }))],
  });

  it('best prices are the top of the public book; an empty side is null', async () => {
    const fake = fakeVenue();
    fake.info.l2Book = book(
      [
        ['58737', '0.1'],
        ['58730', '1'],
      ],
      [],
    );
    const read = await venueWith(fake).bestPrices('BTC-PERP');
    expect(read.value).toEqual({ symbol: 'BTC-PERP', bid: a('58737'), ask: null });
    expect(read.reportedAt?.getTime()).toBe(NOW);
  });

  it('prints: newest first, at most limit, the taker side named, the id kept exact (a hash past a safe number)', async () => {
    const fake = fakeVenue();
    let asked: Record<string, unknown> = {};
    fake.info.recentTrades = (b) => {
      asked = b;
      return [
        { coin: 'BTC', side: 'A', px: '58731.0', sz: '0.00002', time: NOW - 2000, hash: '0xaa', tid: 614600037758557 },
        { coin: 'BTC', side: 'B', px: '58740.5', sz: '0.5', time: NOW - 1000, hash: '0xbb', tid: 2 ** 60 },
        { coin: 'BTC', side: 'B', px: '58700', sz: '1', time: NOW - 3000, hash: '0xcc', tid: 7 },
      ];
    };
    const read = await venueWith(fake).trades('BTC-PERP', 2);
    expect(asked).toEqual({ type: 'recentTrades', coin: 'BTC' });
    expect(read.value).toEqual([
      { tradeId: '0xbb', symbol: 'BTC-PERP', price: a('58740.5'), amount: a('0.5'), takerSide: 'buy', tradedAt: new Date(NOW - 1000) },
      {
        tradeId: '614600037758557',
        symbol: 'BTC-PERP',
        price: a('58731'),
        amount: a('0.00002'),
        takerSide: 'sell',
        tradedAt: new Date(NOW - 2000),
      },
    ]);
    expect(read.reportedAt?.getTime()).toBe(NOW - 1000);
  });

  it('a price sent as a JSON number is refused, never read as a float', async () => {
    const fake = fakeVenue();
    fake.info.recentTrades = () => [{ coin: 'BTC', side: 'B', px: 58740.5, sz: '0.5', time: NOW, hash: '0xbb', tid: 1 }];
    await expect(venueWith(fake).trades('BTC-PERP', 5)).rejects.toThrow(/not a string/);
  });

  it('candles: the window asked is limit intervals back from now, oldest first, the newest limit kept', async () => {
    const fake = fakeVenue();
    let asked: Record<string, unknown> = {};
    const c = (t: number, o: string, cl: string) => ({
      t,
      T: t + 3_599_999,
      s: 'BTC',
      i: '1h',
      o,
      c: cl,
      h: '59953',
      l: '58856',
      v: '1.13873',
      n: 3,
    });
    fake.info.candleSnapshot = (b) => {
      asked = b;
      return [
        c(NOW - 3_600_000, '58959', '58731'),
        c(NOW - 3 * 3_600_000, '59216', '59312'),
        c(NOW - 2 * 3_600_000, '59365', '59146'),
        { ...c(NOW, '58731', '58731'), v: '0.0', n: 0 }, // no print in this interval: not a candle
      ];
    };
    const read = await venueWith(fake).candles('BTC-PERP', '1h', 2);
    // The window ends where the current candle ends, so every desk asking within this hour asks the same read.
    expect(asked).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1h', startTime: NOW - 3_600_000, endTime: NOW + 3_600_000 - 1 },
    });
    expect(read.value.map((x) => [x.openAt.getTime(), x.openPrice, x.closePrice])).toEqual([
      [NOW - 2 * 3_600_000, a('59365'), a('59146')],
      [NOW - 3_600_000, a('58959'), a('58731')],
    ]);
    expect(read.value[0]).toMatchObject({ highPrice: a('59953'), lowPrice: a('58856'), baseVolume: a('1.13873') });
  });

  it('candles from a time start there; an interval the venue does not publish and an unlisted market are refused', async () => {
    const fake = fakeVenue();
    let asked: Record<string, unknown> = {};
    fake.info.candleSnapshot = (b) => ((asked = b), []);
    await venueWith(fake).candles('ETH-PERP', '15m', { limit: 10, since: new Date(NOW - 60_000) });
    expect(asked).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'ETH', interval: '15m', startTime: NOW - 60_000, endTime: NOW + 900_000 - 1 },
    });
    await refusedWith(venueWith(fake).candles('BTC-PERP', '6h', 10), 'not_offered');
    await refusedWith(venueWith(fake).candles('DOGE-PERP', '1h', 10), 'unknown_market');
    await refusedWith(venueWith(fake).trades('DOGE-PERP', 10), 'unknown_market');
  });

  it('a failed read is venue_down: nothing changed', async () => {
    const fake = fakeVenue();
    await refusedWith(venueWith(fake).trades('BTC-PERP', 10), 'venue_down'); // no recentTrades handler: HTTP 400
  });
});

describe('HIP-3 perp DEXs: the stock, index and gold perpetuals', () => {
  // The test network's answers, cut down (read 27 Nov 2026): `perpDexs` lists the main DEX as null, then each HIP-3 DEX;
  // `metaAndAssetCtxs` with `dex` lists that DEX's markets under `<dex>:<coin>`, with their live open interest.
  const XYZ_DEPLOYER = '0x7770132f86dd4002d018edd7d348f4a0e4340777';
  const PERP_DEXS = [
    null,
    { name: 'test', fullName: 'test dex', deployer: '0x5e89b26d8d66da9888c835c9bfcc2aa51813e152', assetToStreamingOiCap: [] },
    { name: 'xyz', fullName: 'XYZ', deployer: XYZ_DEPLOYER, assetToStreamingOiCap: [['xyz:TSLA', '50000000.0']] },
  ];
  const XYZ_META = {
    universe: [
      { name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10, growthMode: 'enabled' },
      { name: 'xyz:HOOD', szDecimals: 3, maxLeverage: 10, onlyIsolated: true, marginMode: 'noCross' },
      { name: 'xyz:URANIUM', szDecimals: 3, maxLeverage: 10, onlyIsolated: true, isDelisted: true },
      { name: 'xyz:SKHX', szDecimals: 3, maxLeverage: 10, onlyIsolated: true },
    ],
    collateralToken: 0,
  };
  const XYZ_CTXS = [
    { markPx: '378.82', openInterest: '51.352', funding: '0.0' },
    { markPx: '71.0', openInterest: '0.626', funding: '0.0' },
    { markPx: '85.0', openInterest: '0.0', funding: '0.0' },
    { markPx: '866.135', openInterest: '0.0', funding: '0.0' },
  ];

  function hip3Venue() {
    const fake = fakeVenue();
    fake.info.perpDexs = () => PERP_DEXS;
    fake.info.metaAndAssetCtxs = (b) =>
      b.dex === 'xyz' ? [XYZ_META, XYZ_CTXS] : [META, [{ markPx: '60000' }, { markPx: '2010' }, { markPx: '1' }]];
    const venue = new HyperliquidTestnetUserVenue({
      appEnv: 'test',
      fetch: fake.fetch,
      clock: () => new Date(NOW),
      timeoutMs: 50,
      perpDexs: ['xyz'],
    });
    return { fake, venue };
  }

  it('lists each live market of a named DEX under its dex prefix, and no delisted or untraded one', async () => {
    const { venue } = hip3Venue();
    const listed = (await venue.markets(null)).value;
    const symbols = listed.map((m) => m.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP', 'xyz:TSLA-PERP', 'xyz:HOOD-PERP']));
    expect(symbols).not.toContain('xyz:URANIUM-PERP');
    expect(symbols).not.toContain('xyz:SKHX-PERP');
    const tsla = listed.find((m) => m.symbol === 'xyz:TSLA-PERP')!;
    expect([tsla.kind, tsla.baseAsset, tsla.quoteAsset, tsla.lotSize, tsla.maxLeverageBps]).toEqual([
      'perpetual',
      'xyz:TSLA',
      'USDC',
      a('0.001'),
      100_000,
    ]);
    // Who listed it is the DEX's own deployer, as the venue names it.
    expect(tsla.listedBy).toEqual({ known: true, value: { kind: 'hip3', name: 'XYZ' } });
    // The venue's own margin flag: a no-cross market is isolated only.
    expect(listed.find((m) => m.symbol === 'xyz:HOOD-PERP')!.marginModes).toEqual(['isolated']);
    expect(tsla.marginModes).toEqual(['cross', 'isolated']);
  });

  it('an order on a HIP-3 market signs its DEX asset id: 100000 + DEX index × 10000 + its index in the DEX', async () => {
    const { venue } = hip3Venue();
    const prepared = await venue.prepare(account, ownerSigner, order({ symbol: 'xyz:HOOD-PERP', amount: a('0.5'), price: a('70') }));
    const cloid = venueClientOrderId(HL_TESTNET_VENUE_ID, 'order:test-user:desk:1');
    const action = {
      type: 'order',
      orders: [{ a: 120_001, b: true, p: '70', s: '0.5', r: false, t: { limit: { tif: 'Gtc' } }, c: cloid }],
      grouping: 'na',
    };
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(actionHash(action, null, BigInt(NOW)));
  });

  it('positions and open orders are read on every named DEX, each with its own mark', async () => {
    const { fake, venue } = hip3Venue();
    const position = (coin: string, szi: string) => ({
      position: {
        coin,
        szi,
        entryPx: '370',
        unrealizedPnl: '0.5',
        marginUsed: '37',
        liquidationPx: null,
        leverage: { type: 'isolated', value: 5 },
      },
    });
    fake.info.clearinghouseState = (b) => ({
      marginSummary: { accountValue: '0' },
      withdrawable: '0',
      time: NOW,
      assetPositions: b.dex === 'xyz' ? [position('xyz:TSLA', '0.1')] : [position('ETH', '-0.5')],
    });
    fake.info.frontendOpenOrders = (b) =>
      b.dex === 'xyz'
        ? [
            {
              coin: 'xyz:TSLA',
              side: 'B',
              limitPx: '300',
              sz: '0.1',
              origSz: '0.1',
              oid: 9,
              tif: 'Gtc',
              orderType: 'Limit',
              reduceOnly: false,
            },
          ]
        : [];
    const positions = (await venue.positions(account)).value;
    expect(positions.map((p) => [p.symbol, p.side, p.markPrice])).toEqual([
      ['ETH-PERP', 'short', a('2010')],
      ['xyz:TSLA-PERP', 'long', a('378.82')],
    ]);
    const open = (await venue.openOrders(account)).value;
    expect(open.map((o) => [o.symbol, o.price])).toEqual([['xyz:TSLA-PERP', a('300')]]);
  });

  // One named DEX the venue doesn't list, or whose read fails, is left out with a warning naming it; the main
  // listing, and every other named DEX, stays up.
  function hip3VenueWarning(perpDexs: readonly string[]) {
    const { fake } = hip3Venue();
    const warnings: string[] = [];
    const venue = new HyperliquidTestnetUserVenue({
      appEnv: 'test',
      fetch: fake.fetch,
      clock: () => new Date(NOW),
      timeoutMs: 50,
      perpDexs,
      warn: (message) => warnings.push(message),
    });
    return { fake, venue, warnings };
  }

  it('a named DEX that perpDexs does not list is left out with a warning naming it; the main and other DEX markets stay listed', async () => {
    const { venue, warnings } = hip3VenueWarning(['gone', 'xyz']);
    const symbols = (await venue.markets(null)).value.map((m) => m.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP', 'xyz:TSLA-PERP', 'xyz:HOOD-PERP']));
    expect(symbols.some((s) => s.startsWith('gone:'))).toBe(false);
    expect(warnings).toEqual(['venue listing: the perp DEX gone is left out: it is not listed by perpDexs']);
  });

  it('a named DEX whose metaAndAssetCtxs read fails is left out with a warning naming it; the main markets stay listed', async () => {
    const { fake, venue, warnings } = hip3VenueWarning(['xyz']);
    const main = fake.info.metaAndAssetCtxs!;
    fake.info.metaAndAssetCtxs = (b) => (b.dex === 'xyz' ? 'not an answer' : main(b));
    const symbols = (await venue.markets(null)).value.map((m) => m.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP']));
    expect(symbols.some((s) => s.startsWith('xyz:'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^venue listing: the perp DEX xyz is left out: /);
  });

  it('a failing perpDexs read leaves every named DEX out with a warning; the main markets stay listed', async () => {
    const { fake, venue, warnings } = hip3VenueWarning(['xyz']);
    delete fake.info.perpDexs; // no handler: HTTP 400
    const symbols = (await venue.markets(null)).value.map((m) => m.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['BTC-PERP', 'ETH-PERP']));
    expect(symbols.some((s) => s.includes(':'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^venue listing: the perp DEXs xyz are left out: /);
  });

  it('with no DEX named, nothing beyond the main listing is read', async () => {
    const fake = fakeVenue();
    const symbols = (await venueWith(fake).markets(null)).value.map((m) => m.symbol);
    expect(symbols.some((s) => s.includes(':'))).toBe(false);
    expect(fake.infoTypes).not.toContain('perpDexs');
  });
});

describe('moving a resting order: one signed `modify`, never cancel then place (#11020)', () => {
  const RESTING = order({ clientOrderKey: 'order:test-user:desk:resting' });
  const restingId = venueClientOrderId(HL_TESTNET_VENUE_ID, RESTING.clientOrderKey);
  const replacement = order({ clientOrderKey: 'order:test-user:desk:replacement', price: a('1990') });
  const replacementId = venueClientOrderId(HL_TESTNET_VENUE_ID, replacement.clientOrderKey);
  const move: VenueIntent = { kind: 'replace_order', symbol: 'ETH-PERP', venueClientOrderId: restingId, order: replacement };
  const modifyOf = (oid: string, c: string, p: string, s: string) => ({
    type: 'modify',
    oid,
    order: { a: 1, b: true, p, s, r: false, t: { limit: { tif: 'Gtc' } }, c },
  });

  it('replace_order is one modify of the resting order, the replacement under its own client id, signed once and sent once', async () => {
    const fake = fakeVenue();
    // The venue's record after the modify: the order at its new price, under the replacement's client id.
    fake.info.orderStatus = (b) => ({
      status: 'order',
      order: {
        status: 'open',
        statusTimestamp: NOW,
        order: {
          coin: 'ETH',
          side: 'B',
          limitPx: '1990',
          sz: '0.5',
          origSz: '0.5',
          oid: 78,
          cloid: b.oid,
          tif: 'Gtc',
          orderType: 'Limit',
          reduceOnly: false,
        },
      },
    });
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, move);
    expect(prepared.venueClientOrderId).toBe(replacementId);
    const action = modifyOf(restingId, replacementId, '1990', '0.5');
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(actionHash(action, null, BigInt(prepared.nonce)));
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(fake.exchangeBodies).toHaveLength(1);
    expect(fake.exchangeBodies[0]!.action).toEqual(action);
    if (!outcome.definite || !outcome.accepted) throw new Error('expected the modify accepted');
    const [cancelled, placed] = outcome.legs ?? [];
    expect(cancelled).toMatchObject({ definite: true, accepted: true });
    expect(placed).toMatchObject({ definite: true, accepted: true, venueRef: '78' });
    expect(placed?.definite && placed.accepted ? placed.order : null).toMatchObject({
      venueClientOrderId: replacementId,
      price: a('1990'),
      status: 'open',
    });
  });

  it('a modify refused, or racing a fill, says so, keeps the venue words, and is never sent again', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, move);
    fake.exchange.push(err('Cannot modify canceled or filled order'));
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(fake.exchangeBodies).toHaveLength(1);
    expect(outcome).toEqual({
      definite: true,
      accepted: false,
      refusal: { venueId: HL_TESTNET_VENUE_ID, code: 'order_final', detail: 'Cannot modify canceled or filled order' },
      asOf: new Date(NOW),
    });
    const other = await venue.prepare(account, ownerSigner, move);
    fake.exchange.push(err('Order must have minimum value of $10.'));
    const refused = await venue.submit(other, await sign(ownerKey, other));
    expect(refused.definite && !refused.accepted ? refused.refusal : null).toMatchObject({
      code: 'venue_rejected',
      detail: 'Order must have minimum value of $10.',
    });
  });

  it('a lost modify answer is not definite: it is read back by the replacement client id and never resent', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, move);
    fake.exchange.push('timeout');
    expect(await venue.submit(prepared, await sign(ownerKey, prepared))).toEqual({ definite: false, reason: 'timeout' });
    expect(fake.exchangeBodies).toHaveLength(1);
    const read = await venue.orderByClientId(account, prepared.venueClientOrderId!);
    expect(read.value?.venueClientOrderId).toBe(replacementId);
    expect(fake.exchangeBodies).toHaveLength(1);
  });

  it('a replacement the one modify cannot carry is refused before anything is signed', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const replace = (o: Partial<PlaceUserOrderIntent>, symbol = 'ETH-PERP'): VenueIntent => ({
      kind: 'replace_order',
      symbol,
      venueClientOrderId: restingId,
      order: { ...replacement, ...o },
    });
    await refusedWith(venue.prepare(account, ownerSigner, replace({ clientOrderKey: RESTING.clientOrderKey })), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, replace({}, 'BTC-PERP')), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, replace({ type: 'market', timeInForce: 'IOC' })), 'not_offered');
    await refusedWith(
      venue.prepare(account, ownerSigner, replace({ trigger: { price: a('1900'), source: 'mark', role: 'stop_loss' } })),
      'not_offered',
    );
    await refusedWith(venue.prepare(account, ownerSigner, replace({ builderFee: { builder: BUILDER, feeBps: a('0.5') } })), 'not_offered');
    await refusedWith(venue.prepare(account, ownerSigner, replace({ amount: a('0.123456') })), 'venue_rejected');
    expect(fake.exchangeBodies).toHaveLength(0);
  });

  it('amend_order is one modify that keeps the client id, the side and the time in force the venue holds', async () => {
    const fake = fakeVenue();
    const venue = venueWith(fake);
    const amend: VenueIntent = {
      kind: 'amend_order',
      symbol: 'ETH-PERP',
      venueClientOrderId: restingId,
      amount: a('0.3'),
      price: a('1995'),
    };
    const prepared = await venue.prepare(account, ownerSigner, amend);
    expect(prepared.venueClientOrderId).toBe(restingId);
    const action = modifyOf(restingId, restingId, '1995', '0.3');
    expect((prepared.typedData as L1TypedData).message.connectionId).toBe(actionHash(action, null, BigInt(prepared.nonce)));
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(fake.exchangeBodies).toHaveLength(1);
    expect(fake.exchangeBodies[0]!.action).toEqual(action);
    expect(outcome).toMatchObject({ definite: true, accepted: true });
    // An order the venue no longer holds open is not amended: nothing is signed.
    fake.info.orderStatus = () => ({ status: 'unknownOid' });
    await refusedWith(venueWith(fake).prepare(account, ownerSigner, amend), 'unknown_order');
    expect(fake.exchangeBodies).toHaveLength(1);
  });
});

describe('shared reads across testers: one IP, 1,200 weight a minute (#11028)', () => {
  const STRANGER = strangerKey.address.toLowerCase();
  const strangers: UserVenueAccount = { venueId: HL_TESTNET_VENUE_ID, owner: STRANGER, subAccount: null };
  function sharedVenue(fake: Fake, clock: () => number, onWeightMinute?: (spent: VenueWeightMinute) => void) {
    return new HyperliquidTestnetUserVenue({
      appEnv: 'test',
      fetch: fake.fetch,
      clock: () => new Date(clock()),
      timeoutMs: 50,
      shareReads: true,
      ...(onWeightMinute ? { onWeightMinute } : {}),
    });
  }
  const count = (fake: Fake, type: string) => fake.infoTypes.filter((t) => t === type).length;

  it("an order forgets only its own wallet's reads: another tester's fills and the market's prints stay shared", async () => {
    const fake = fakeVenue();
    fake.info.userFillsByTime = () => [];
    fake.info.recentTrades = () => [];
    const venue = sharedVenue(fake, () => NOW);
    const since = new Date(NOW - 60_000);
    const readAll = async () => {
      await venue.fills(account, since);
      await venue.fills(strangers, since);
      await venue.trades('ETH-PERP', 10);
    };
    await readAll();
    expect([count(fake, 'userFillsByTime'), count(fake, 'recentTrades')]).toEqual([2, 1]);
    const prepared = await venue.prepare(account, ownerSigner, order());
    fake.exchange.push(orderStatus({ resting: { oid: 77, cloid: prepared.venueClientOrderId } }));
    await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(fake.exchangeBodies).toHaveLength(1);
    const fillsBefore = count(fake, 'userFillsByTime');
    await readAll();
    // The ordering wallet's fills are read again; the stranger's and the market's prints are served as kept.
    expect(count(fake, 'userFillsByTime')).toBe(fillsBefore + 1);
    expect(count(fake, 'recentTrades')).toBe(1);
  });

  it('fills: desks asking from moments a few seconds apart share one read of the hour, and each gets only its own fills since (#11041)', async () => {
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
    const hour = Math.floor((NOW - 30 * 60_000) / FILLS_GRID_MS) * FILLS_GRID_MS;
    const all = [fill(1, hour + 1_000), fill(2, hour + 5_000), fill(3, hour + 9_000)];
    const starts: number[] = [];
    fake.info.userFillsByTime = (b) => (starts.push(Number(b.startTime)), all.filter((f) => f.time >= Number(b.startTime)));
    const venue = sharedVenue(fake, () => NOW);
    const first = (await venue.fills(account, new Date(hour + 1_000))).value;
    const second = (await venue.fills(account, new Date(hour + 4_000))).value;
    expect(starts).toEqual([hour]);
    expect(first.map((f) => f.fillId)).toEqual([`${hour + 1_000}:ETH:1`, `${hour + 5_000}:ETH:2`, `${hour + 9_000}:ETH:3`]);
    expect(second.map((f) => f.fillId)).toEqual([`${hour + 5_000}:ETH:2`, `${hour + 9_000}:ETH:3`]);
  });

  it('fills: a full page answered entirely before the asked start keeps paging to the fills after it (#11041)', async () => {
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
    const hour = Math.floor(NOW / FILLS_GRID_MS) * FILLS_GRID_MS;
    const since = hour + 30 * 60_000;
    // A full page of fills between the hour and the asked start, then one fill after it.
    const all = [...Array.from({ length: FILLS_PAGE_CAP }, (_, i) => fill(i + 1, hour + i)), fill(9_999, since + 1)];
    fake.info.userFillsByTime = (b) => all.filter((f) => f.time >= Number(b.startTime)).slice(0, FILLS_PAGE_CAP);
    const fills = (await venueWith(fake).fills(account, new Date(since))).value;
    expect(fills.map((f) => f.fillId)).toEqual([`${since + 1}:ETH:9999`]);
  });

  it('candles: every desk asking within one candle asks the same window, so they share one read', async () => {
    const fake = fakeVenue();
    const asked: unknown[] = [];
    fake.info.candleSnapshot = (b) => (asked.push(b.req), []);
    let now = NOW + 1_234;
    const venue = sharedVenue(fake, () => now);
    await venue.candles('BTC-PERP', '1m', 100);
    now += 10_001; // another desk, a different millisecond inside the same minute and the read's 15 s
    await venue.candles('BTC-PERP', '1m', 100);
    expect(asked).toEqual([{ coin: 'BTC', interval: '1m', startTime: NOW + 60_000 - 100 * 60_000, endTime: NOW + 60_000 - 1 }]);
    now = NOW + 60_000; // the next candle opens: a new window
    await venue.candles('BTC-PERP', '1m', 100);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual({ coin: 'BTC', interval: '1m', startTime: NOW + 2 * 60_000 - 100 * 60_000, endTime: NOW + 2 * 60_000 - 1 });
  });

  it('counts the weight spent at the venue by request type, and tells it once a minute', async () => {
    const fake = fakeVenue();
    fake.info.userFillsByTime = () => Array.from({ length: 45 }, () => ({}));
    fake.info.l2Book = (b) => ({ coin: b.coin, time: NOW, levels: [[], []] });
    const told: VenueWeightMinute[] = [];
    let now = NOW;
    const venue = sharedVenue(
      fake,
      () => now,
      (spent) => told.push(spent),
    );
    await venue.fills(account, new Date(NOW - 60_000)).catch(() => null); // 45 fills: 20 + 2 per the venue's 1 per 20
    await venue.book('ETH-PERP', 5).catch(() => null);
    await venue.book('ETH-PERP', 5).catch(() => null); // kept: no second request, no weight
    expect(told).toEqual([]);
    now += 60_000;
    await venue.book('BTC-PERP', 5).catch(() => null);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      minute: new Date(NOW).toISOString(),
      byType: { userFillsByTime: { requests: 1, weight: 22 }, l2Book: { requests: 1, weight: 2 } },
    });
    // The listing read on the way (meta, spotMeta) is counted too: the total is every request's weight.
    const byType = Object.values(told[0]!.byType);
    expect(told[0]!.weight).toBe(byType.reduce((n, r) => n + r.weight, 0));
    expect(told[0]!.byType.meta).toEqual({ requests: 1, weight: 20 });
  });
});

// A fresh tester's grant lands in perps (the venue's default mode keeps spot apart), so a spot buy needs a
// move from perps to spot. The adapter reads the account's mode and signs that move (J-derivatives-29 #1 #2).
describe('the account mode and a move between spot and perps (J-derivatives-29)', () => {
  const withAccount = (abstraction: unknown) => {
    const fake = fakeVenue();
    fake.info.userAbstraction = () => abstraction;
    fake.info.clearinghouseState = () => ({ marginSummary: { accountValue: '25' }, withdrawable: '25', assetPositions: [], time: NOW });
    fake.info.spotClearinghouseState = () => ({ balances: [{ coin: 'USDC', token: 0, total: '1.5', hold: '0.5', entryNtl: '0' }] });
    return fake;
  };
  const move = {
    kind: 'spot_perps_transfer',
    direction: 'perps_to_spot',
    asset: 'USDC',
    amount: a('9.4365'),
    moveKey: 'class-move:test-user:1',
  } as const;

  it("reads the venue's default and disabled modes as standard, with spot and perps USDC apart", async () => {
    for (const abstraction of ['default', 'disabled']) {
      const read = await venueWith(withAccount(abstraction)).accountMode(account);
      expect(read.value).toEqual({
        mode: 'standard',
        spot: [{ asset: 'USDC', free: a('1'), locked: a('0.5'), total: a('1.5') }],
        perps: [{ asset: 'USDC', free: a('25'), locked: ZERO, total: a('25') }],
        actions: null,
      });
    }
  });

  it('reads unified and portfolio margin as one balance (no spot or perps apart); a word it does not know is not known', async () => {
    expect((await venueWith(withAccount('unifiedAccount')).accountMode(account)).value).toEqual({
      mode: 'unified',
      spot: null,
      perps: null,
      actions: null,
    });
    expect((await venueWith(withAccount('portfolioMargin')).accountMode(account)).value.mode).toBe('portfolio_margin');
    expect((await venueWith(withAccount('somethingNew')).accountMode(account)).value.mode).toBeNull();
  });

  it('perps to spot: the owner signs usdClassTransfer on the testnet chain, toPerp false, and the venue takes it', async () => {
    const fake = withAccount('default');
    const venue = venueWith(fake);
    const prepared = await venue.prepare(account, ownerSigner, move);
    const typed = prepared.typedData as UserSignedTypedData;
    expect(typed.primaryType).toBe('HyperliquidTransaction:UsdClassTransfer');
    expect(typed.domain.chainId).toBe(84532);
    expect(typed.message).toEqual({ hyperliquidChain: 'Testnet', amount: '9.4365', toPerp: false, nonce: BigInt(NOW) });
    const outcome = await venue.submit(prepared, await sign(ownerKey, prepared));
    expect(outcome).toMatchObject({ definite: true, accepted: true });
    expect(fake.exchangeBodies[0]!.action).toEqual({
      type: 'usdClassTransfer',
      signatureChainId: '0x14a34',
      hyperliquidChain: 'Testnet',
      amount: '9.4365',
      toPerp: false,
      nonce: NOW,
    });
    const back = await venue.prepare(account, ownerSigner, { ...move, direction: 'spot_to_perps', moveKey: 'class-move:test-user:2' });
    expect((back.typedData as UserSignedTypedData).message.toPerp).toBe(true);
  });

  it('refuses a move that is not USDC, too fine, on a sub-account, by a session key, or in a mode without spot and perps apart', async () => {
    const venue = venueWith(withAccount('default'));
    await refusedWith(venue.prepare(account, ownerSigner, { ...move, asset: 'PURR' }), 'venue_rejected');
    await refusedWith(venue.prepare(account, ownerSigner, { ...move, amount: a('1.0000001') }), 'venue_rejected');
    await refusedWith(
      venue.prepare({ ...account, subAccount: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' }, ownerSigner, move),
      'not_offered',
    );
    await expect(venue.prepare(account, agentSigner, move)).rejects.toThrow();
    const unified = await refusedWith(venueWith(withAccount('unifiedAccount')).prepare(account, ownerSigner, move), 'venue_rejected');
    expect(unified.refusal.detail).toMatch(/unified mode/);
    await refusedWith(venueWith(withAccount('somethingNew')).prepare(account, ownerSigner, move), 'venue_rejected');
  });
});
