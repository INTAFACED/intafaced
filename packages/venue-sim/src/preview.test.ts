import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, sub } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  decodeVenueWire,
  encodeVenueWire,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_CHAIN_ID, type TestVenueTypedData } from './signing.js';
import { TEST_VENUE_MARKETS, answerTestVenue, seedTestVenue, startTestVenueServer } from './http-server.js';

const a = parseAmount;

function wallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner' as const, address },
    async sign(prepared: PreparedVenueAction) {
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

function world(chainId?: number) {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 8, 12)), markets: TEST_VENUE_MARKETS, chainId });
  const w = wallet('preview-trader');
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: w.address, subAccount: null };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, w.signer, intent);
    return sim.submit(prepared, await w.sign(prepared));
  };
  return { sim, w, account, run };
}

const order = (over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'limit',
  amount: a('0.5'),
  price: a('60020'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: 'order:preview-trader:1',
  builderFee: null,
  ...over,
});

describe('EIP-712 chain id', () => {
  it('defaults to the simulator chain id and takes the stack chain id as an option', async () => {
    const def = world();
    const base = world(84532);
    const intent: VenueIntent = { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' };
    const p1 = await def.sim.prepare(def.account, def.w.signer, intent);
    const p2 = await base.sim.prepare(base.account, base.w.signer, intent);
    expect((p1.typedData as TestVenueTypedData).domain.chainId).toBe(TEST_VENUE_CHAIN_ID);
    expect((p2.typedData as TestVenueTypedData).domain.chainId).toBe(84532);
    expect(p1.digest).not.toBe(p2.digest);
    // A signature made on one chain id's domain does not verify on the other's.
    const sig = await def.w.sign(p1);
    await expect(base.sim.submit({ ...p2, digest: p1.digest }, sig)).rejects.toMatchObject({ refusal: { code: 'signature_mismatch' } });
    expect((await base.sim.submit(p2, await base.w.sign(p2))).definite).toBe(true);
  });
});

describe('preview', () => {
  it('a spot buy that meets the seeded ladder: taker, fees at fill prices in the base, lock what place locks', async () => {
    const { sim, account, run } = world();
    await seedTestVenue(sim);
    sim.deposit(account, 'USDC', a('100000'), 'dep:1');
    // Asks rest at 60010 and 60020, 1 BTC each: 1.5 BTC at 60020 takes 1 at 60010 and 0.5 at 60020.
    const intent = order({ amount: a('1.5') });
    const preview = (await sim.preview(account, intent)).value;
    expect(preview.role).toBe('taker');
    expect(preview.lock).toEqual({ asset: 'USDC', amount: a('90030') });
    // Taker 3.5 bps on the base received: 1.5 BTC × 0.00035.
    expect(preview.venueFee).toEqual({ known: true, value: { asset: 'BTC', amount: a('0.000525') } });
    expect(preview.builderFee).toEqual({ known: true, value: { asset: 'BTC', amount: 0n } });
    expect(preview.perpetual).toBeNull();

    const before = (await sim.balances(account)).value.find((b) => b.asset === 'BTC')?.free ?? 0n;
    const outcome = await run(intent);
    expect(outcome.definite && outcome.accepted).toBe(true);
    const fills = (await sim.fills(account, new Date(0))).value;
    const fees = fills.reduce((s, f) => s + f.venueFee, 0n);
    expect(fees).toBe(a('0.000525'));
    const after = (await sim.balances(account)).value.find((b) => b.asset === 'BTC')?.free ?? 0n;
    expect(sub(after, before)).toBe(sub(a('1.5'), fees));
  });

  it('a resting buy is maker, with the builder fee line from the order', async () => {
    const { sim, account } = world();
    await seedTestVenue(sim);
    const builder = '0x00000000000000000000000000000000000000b1';
    const preview = (await sim.preview(account, order({ price: a('59000'), amount: a('1'), builderFee: { builder, feeBps: a('2') } })))
      .value;
    expect(preview.role).toBe('maker');
    expect(preview.lock).toEqual({ asset: 'USDC', amount: a('59000') });
    expect(preview.venueFee).toEqual({ known: true, value: { asset: 'BTC', amount: a('0.0001') } });
    expect(preview.builderFee).toEqual({ known: true, value: { asset: 'BTC', amount: a('0.0002') } });
  });

  it('an unpublished maker fee is not known, never zero', async () => {
    const markets = TEST_VENUE_MARKETS.map((m) => (m.kind === 'spot' ? { ...m, makerFeeBps: { known: false } as const } : m));
    const sim = new TestVenueSimulator({ clock: () => new Date(), markets });
    const w = wallet('x');
    const preview = (await sim.preview({ venueId: sim.venue.id, owner: w.address, subAccount: null }, order({ price: a('50000') }))).value;
    expect(preview.venueFee).toEqual({ known: false });
  });

  it('a perp: refuses leverage_not_set, then gives margin, lock and the liquidation price of the position it opens', async () => {
    const { sim, account, run } = world();
    await seedTestVenue(sim);
    sim.deposit(account, 'USDC', a('100000'), 'dep:1');
    const intent = order({ symbol: 'BTC-PERP', amount: a('1'), price: a('60010'), clientOrderKey: 'order:preview-trader:perp' });
    await expect(sim.preview(account, intent)).rejects.toMatchObject({ refusal: { code: 'leverage_not_set' } });
    await run({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' });

    const preview = (await sim.preview(account, intent)).value;
    expect(preview.role).toBe('taker');
    // 10x: margin 6001; the lock adds the taker fee buffer 60010 × 4.5 bps = 27.0045.
    expect(preview.perpetual?.initialMargin).toEqual({ known: true, value: a('6001') });
    expect(preview.lock).toEqual({ asset: 'USDC', amount: a('6028.0045') });
    expect(preview.venueFee).toEqual({ known: true, value: { asset: 'USDC', amount: a('27.0045') } });

    await run(intent);
    const position = (await sim.positions(account)).value[0];
    expect(position?.margin).toBe(a('6001'));
    expect(preview.perpetual?.liquidationPrice).toEqual(position?.liquidationPrice);
  });

  it('refuses what prepare refuses on its face', async () => {
    const { sim, account } = world();
    await expect(sim.preview(account, order({ symbol: 'ETH-USDC' }))).rejects.toBeInstanceOf(VenueRefusalError);
    sim.switches.venueDown = true;
    await expect(sim.preview(account, order({}))).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
  });
});

describe('HTTP answers', () => {
  it('runs prepare → sign → submit → read with every Amount as a decimal string on the wire', async () => {
    const { sim, w, account } = world(84532);
    const call = async (path: string, body: unknown) => {
      const [status, out] = await answerTestVenue(sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
      return { status, out: decodeVenueWire<any>(JSON.parse(JSON.stringify(out))), raw: out as any };
    };
    expect((await call('/test/seed', {})).out.orders).toBe(20);
    expect((await call('/test/seed', {})).out.orders).toBe(0);
    expect((await call('/test/deposit', { account, asset: 'USDC', amount: a('70000'), depositRef: 'dep:http' })).out.credited).toBe(true);
    expect((await call('/test/deposit', { account, asset: 'USDC', amount: a('70000'), depositRef: 'dep:http' })).out.credited).toBe(false);

    const intent = order({ amount: a('1'), price: a('60010'), clientOrderKey: 'order:preview-trader:http' });
    const preview = await call('/preview', { account, intent });
    expect(preview.raw.value.lock.amount).toBe('60010');
    const prepared = await call('/prepare', { account, signer: w.signer, intent });
    expect(prepared.status).toBe(200);
    expect(typeof prepared.raw.intent.amount).toBe('string');
    const signature = await w.sign(prepared.out);
    const submitted = await call('/submit', { prepared: prepared.out, signature });
    expect(submitted.out).toMatchObject({ definite: true, accepted: true });
    const again = await call('/submit', { prepared: prepared.out, signature });
    expect(again.out.order.venueOrderId).toBe(submitted.out.order.venueOrderId);
    const balances = await call('/balances', { account });
    expect(balances.raw.value.find((b: any) => b.asset === 'BTC').free).toBe('0.99965');

    const [status, body] = await answerTestVenue(
      sim,
      'POST',
      '/prepare',
      JSON.stringify({ account, signer: w.signer, intent: { ...(encodeVenueWire(intent) as object), amount: 1 } }),
    );
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/decimal string/);

    await call('/test/switches', { venueDown: true });
    const down = await call('/balances', { account });
    expect(down.status).toBe(422);
    expect(down.raw.refusal.code).toBe('venue_down');
  });

  it('refuses to start unless APP_ENV is exactly dev or test, and off loopback', async () => {
    for (const appEnv of [undefined, '', 'prod', 'staging', 'DEV', ' dev']) {
      await expect(startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv })).rejects.toMatchObject({
        refusal: { code: 'test_venue_outside_test' },
      });
    }
    await expect(startTestVenueServer({ host: '0.0.0.0', port: 0, appEnv: 'test' })).rejects.toThrow(/loopback/);
    const { server, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 });
    try {
      const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).json();
      expect(health).toMatchObject({ ok: true, label: 'TEST', chainId: 84532 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
