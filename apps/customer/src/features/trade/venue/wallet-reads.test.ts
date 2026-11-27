import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { venueApi } from '../venue-api';

// Where the door names the venue's public read endpoint, a person's own fills, balances, positions, open orders and
// orders by client id are read from this browser, so they count against the person's IP and not the box's;
// everything else reads through the door. The person's own order labels come from the door's record, not the venue.

const OWNER = '0x00000000000000000000000000000000000000AA';
const STATUS = {
  enabled: true,
  available: true,
  venue: { id: 'hyperliquid-testnet', displayName: 'TEST venue (testnet)', proofLevel: 'partner-sandbox' },
  test: true,
  label: 'TEST',
  chainId: 421614,
  builder: null,
};
const NAMED = { baseUrl: 'https://api.hyperliquid-testnet.xyz', perpDexs: [] };

/** The venue's own answers, by request type (TEST figures). */
const VENUE: Record<string, unknown> = {
  clearinghouseState: {
    marginSummary: { accountValue: '125.5', totalNtlPos: '0', totalRawUsd: '125.5', totalMarginUsed: '0' },
    withdrawable: '100.25',
    assetPositions: [],
    time: 1795435200000,
  },
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '40', hold: '10', entryNtl: '0' }] },
  userAbstraction: 'default',
  frontendOpenOrders: [
    {
      coin: 'ZZZ',
      side: 'B',
      limitPx: '2',
      sz: '3',
      origSz: '3',
      oid: 11,
      cloid: '0x000000000000000000000000000000AB',
      orderType: 'Limit',
      tif: 'Gtc',
      reduceOnly: true,
    },
    {
      coin: 'ZZZ',
      side: 'A',
      limitPx: '4',
      sz: '1',
      origSz: '1',
      oid: 12,
      cloid: '0x000000000000000000000000000000cd',
      orderType: 'Limit',
      tif: 'Gtc',
      reduceOnly: true,
    },
  ],
  orderStatus: {
    status: 'order',
    order: {
      status: 'canceled',
      statusTimestamp: 1795435200000,
      order: {
        coin: 'ZZZ',
        side: 'B',
        limitPx: '2',
        sz: '0',
        origSz: '3',
        oid: 11,
        cloid: '0x000000000000000000000000000000ab',
        orderType: 'Limit',
        tif: 'Gtc',
        reduceOnly: true,
      },
    },
  },
  meta: { universe: [] },
  spotMeta: { universe: [], tokens: [] },
};

/** The person's own labels, as the door's record answers them (TEST). */
const LABELS = [{ venueClientOrderId: '0x000000000000000000000000000000ab', label: 'my-dip-buy' }];

/** A door that answers its status and counts every other read it is asked. */
function door(status: unknown) {
  const asked: string[] = [];
  const api = createApiClient({
    fetch: async (input) => {
      const path = new URL(String(input), 'http://app.test').pathname.replace(/^\/api\/v1/, '');
      if (path === '/venue/status') return Response.json(status);
      if (path === '/venue/submit') return Response.json({});
      asked.push(path);
      if (path === '/api/trade/trpc/venueOrderLabels.list') return Response.json({ result: { data: { labels: LABELS } } });
      return Response.json({ venueId: 'hyperliquid-testnet', value: [], asOf: new Date(0).toISOString() });
    },
  });
  return { api, asked };
}

/** The test network, answering by request type, with every request it was sent. */
function testNetwork() {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push({ url, body });
    return new Response(JSON.stringify(VENUE[String(body.type)] ?? null), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("the desk's own-wallet reads", () => {
  it('go from this browser to the venue the door names, by the owner address, and read as the door would answer', async () => {
    const sent = testNetwork();
    const { api, asked } = door({ ...STATUS, walletReads: NAMED });
    const read = await venueApi(api).balances(OWNER);
    expect(asked).toEqual([]);
    expect(sent.map((s) => s.url)).toEqual(['https://api.hyperliquid-testnet.xyz/info', 'https://api.hyperliquid-testnet.xyz/info']);
    expect(sent.map((s) => s.body)).toEqual([
      { type: 'clearinghouseState', user: OWNER.toLowerCase() },
      { type: 'spotClearinghouseState', user: OWNER.toLowerCase() },
    ]);
    expect(read.ok && read.data.value).toEqual([
      { asset: 'USDC', free: '30', locked: '10', total: '40' },
      { asset: 'USDC-PERP', free: '100.25', locked: '25.25', total: '125.5' },
    ]);
  });

  it("the account's mode, from this browser too: the venue's default mode is standard, spot and perps USDC apart", async () => {
    const sent = testNetwork();
    const { api, asked } = door({ ...STATUS, walletReads: NAMED });
    const read = await venueApi(api).accountMode(OWNER);
    expect(asked).toEqual([]);
    expect(sent.map((s) => s.body.type).sort()).toEqual(['clearinghouseState', 'spotClearinghouseState', 'userAbstraction']);
    expect(read.ok && read.data.value).toEqual({
      mode: 'standard',
      spot: [{ asset: 'USDC', free: '30', locked: '10', total: '40' }],
      perps: [{ asset: 'USDC', free: '100.25', locked: '25.25', total: '125.5' }],
      actions: null,
    });
  });

  it('read through the door for a sub-account, another venue, or a door that names no wallet reads', async () => {
    const sent = testNetwork();
    const named = door({ ...STATUS, walletReads: NAMED });
    await venueApi(named.api).balances(OWNER, undefined, '0x00000000000000000000000000000000000000bb');
    await venueApi(named.api).positions(OWNER, undefined, { venueId: 'test-venue' });
    expect(named.asked).toEqual(['/venue/balances', '/venue/positions']);
    for (const status of [STATUS, { ...STATUS, walletReads: null }]) {
      const plain = door(status);
      await venueApi(plain.api).balances(OWNER);
      await venueApi(plain.api).fills(OWNER, new Date(0).toISOString());
      expect(plain.asked).toEqual(['/venue/balances', '/venue/fills']);
    }
    expect(sent).toEqual([]);
  });

  it("the page's desk parts share one read of an account, and the person's own submit makes the next read fresh", async () => {
    const sent = testNetwork();
    const { api } = door({ ...STATUS, walletReads: NAMED });
    const venue = venueApi(api);
    await Promise.all([venue.balances(OWNER), venue.balances(OWNER), venueApi(api).balances(OWNER)]);
    expect(sent).toHaveLength(2);
    await venue.balances(OWNER);
    expect(sent).toHaveLength(2);
    await venue.submit('order:test:1', { digest: '0x01', signature: '0x02', signedBy: OWNER });
    await venue.balances(OWNER);
    expect(sent).toHaveLength(4);
  });

  it("open orders and an order by client id come from this browser, with the labels from the door's record", async () => {
    const sent = testNetwork();
    const { api, asked } = door({ ...STATUS, walletReads: NAMED });
    const venue = venueApi(api);
    const open = await venue.openOrders(OWNER);
    expect(sent.map((s) => s.body)).toContainEqual({ type: 'frontendOpenOrders', user: OWNER.toLowerCase() });
    expect(open.ok && open.data.value.map((o) => [o.venueClientOrderId, o.label, o.origin, o.status])).toEqual([
      ['0x000000000000000000000000000000ab', 'my-dip-buy', 'user', 'open'],
      ['0x000000000000000000000000000000cd', null, 'user', 'open'],
    ]);
    const one = await venue.orderByClientId(OWNER, '0x000000000000000000000000000000ab');
    expect(sent.map((s) => s.body)).toContainEqual({
      type: 'orderStatus',
      user: OWNER.toLowerCase(),
      oid: '0x000000000000000000000000000000ab',
    });
    expect(one.ok && one.data.value && [one.data.value.label, one.data.value.status]).toEqual(['my-dip-buy', 'canceled']);
    // Only the labels went through the door, once: the second read's order was already covered by the kept list.
    expect(asked).toEqual(['/api/trade/trpc/venueOrderLabels.list']);
    // The person's own signed action may set a label: the next order read asks for the labels again.
    await venue.submit('order:test:1', { digest: '0x01', signature: '0x02', signedBy: OWNER });
    await venue.openOrders(OWNER);
    expect(asked).toEqual(['/api/trade/trpc/venueOrderLabels.list', '/api/trade/trpc/venueOrderLabels.list']);
  });

  it('open orders and orders by client id read through the door for another venue or a door that names no wallet reads', async () => {
    const sent = testNetwork();
    const named = door({ ...STATUS, walletReads: NAMED });
    await venueApi(named.api).ordersByClientIdOn('test-venue', OWNER, '0x000000000000000000000000000000ab');
    expect(named.asked).toEqual(['/venue/orders/by-client-id']);
    const plain = door(STATUS);
    await venueApi(plain.api).openOrders(OWNER);
    await venueApi(plain.api).orderByClientId(OWNER, '0x000000000000000000000000000000ab');
    expect(plain.asked).toEqual(['/venue/orders/open', '/venue/orders/by-client-id']);
    expect(sent).toEqual([]);
  });

  it("a venue's refusal is the door's refusal: venue down is unreachable, with its code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 429 })),
    );
    const { api } = door({ ...STATUS, walletReads: NAMED });
    const read = await venueApi(api).positions(OWNER);
    expect(read).toMatchObject({ ok: false, reason: 'unreachable', code: 'trade.venue.venue_down', status: 503 });
  });
});
