import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { venueClientOrderId, type PlaceUserOrderIntent, type PreparedVenueAction, type UserVenueAccount } from '@intafaced/venue-contracts';
import type { FetchLike } from './core.js';
import {
  NotRecordedError,
  parseRecording,
  recordingFetch,
  replayRecording,
  traderRecording,
  type HlRecordedCall,
  type HlRecording,
} from './recorded.js';
import { typedDataDigest, type HlTypedData, type L1TypedData } from './signing.js';
import { HL_TESTNET_VENUE_ID, HyperliquidTestnetUserVenue } from './venue.js';

// A live run's answers, kept with the trader as <trader>, are answered again to a run of the same steps by
// another TEST wallet, its own address and order ids written in; a request the recording has no answer for is refused
// and listed, never given another request's answer. The "test network" here is a fake: no test reaches the internet.

const a = parseAmount;
const key = (label: string) => privateKeyToAccount(keccak256(toHex(`intafaced TEST hl replay ${label}`)));
const liveKey = key('live trader');
const replayKey = key('replay trader');
const accountOf = (k: typeof liveKey): UserVenueAccount => ({
  venueId: HL_TESTNET_VENUE_ID,
  owner: k.address.toLowerCase(),
  subAccount: null,
});

function order(clientOrderKey: string, price = '2000'): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol: 'ETH-PERP',
    side: 'buy',
    type: 'limit',
    amount: a('0.5'),
    price: a(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  };
}

async function sign(k: typeof liveKey, prepared: PreparedVenueAction) {
  const typed = prepared.typedData as HlTypedData;
  const signature =
    typed.primaryType === 'Agent' ? await k.signTypedData(typed as L1TypedData) : await k.sign({ hash: typedDataDigest(typed) });
  return { digest: prepared.digest, signature, signedBy: k.address.toLowerCase() };
}

/** The fake test network: one trader's spot USDC, and the one order once placed, resting. */
function fakeTestNetwork(): FetchLike {
  let resting: string | null = null;
  const answer = (path: string, body: Record<string, unknown>): unknown => {
    if (path === '/exchange') {
      resting = (body.action as { orders: { c: string }[] }).orders[0]!.c;
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 91, cloid: resting } }] } } };
    }
    const open = {
      coin: 'ETH',
      side: 'B',
      limitPx: '2000',
      sz: '0.5',
      origSz: '0.5',
      oid: 91,
      cloid: resting,
      tif: 'Gtc',
      orderType: 'Limit',
      reduceOnly: false,
    };
    switch (body.type) {
      case 'meta':
        return { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] };
      case 'spotMeta':
        return { tokens: [{ name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0 }], universe: [] };
      case 'spotClearinghouseState':
        return { balances: [{ coin: 'USDC', token: 0, total: '5000', hold: resting ? '1000' : '0', entryNtl: '0' }] };
      case 'clearinghouseState':
        return { marginSummary: { accountValue: '0' }, withdrawable: '0', assetPositions: [], time: 1 };
      case 'orderStatus':
        return resting ? { status: 'order', order: { status: 'open', statusTimestamp: 1, order: open } } : { status: 'unknownOid' };
      case 'activeAssetData':
        return { leverage: { type: 'cross', value: 10 } };
      case 'frontendOpenOrders':
        return resting ? [{ ...open, timestamp: 1 }] : [];
      default:
        throw new Error(`the fake test network has no ${String(body.type)}`);
    }
  };
  return async (url, init) => {
    const text = JSON.stringify(answer(new URL(url).pathname, JSON.parse(init.body) as Record<string, unknown>));
    return { ok: true, status: 200, text: async () => text };
  };
}

const venueWith = (fetch: FetchLike) => new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch, timeoutMs: 2_000 });

/** The steps: read the balance, place one order, read the open orders and the balance again. */
async function steps(venue: HyperliquidTestnetUserVenue, k: typeof liveKey, orderKey: string, price = '2000') {
  const account = accountOf(k);
  const before = (await venue.balances(account)).value;
  const prepared = await venue.prepare(account, { role: 'owner', address: account.owner }, order(orderKey, price));
  const outcome = await venue.submit(prepared, await sign(k, prepared));
  const open = (await venue.openOrders(account)).value;
  const after = (await venue.balances(account)).value;
  return { before, outcome, open, after, cloid: prepared.venueClientOrderId };
}

async function record(): Promise<{ recording: HlRecording; live: Awaited<ReturnType<typeof steps>> }> {
  const calls: HlRecordedCall[] = [];
  const live = await steps(venueWith(recordingFetch(fakeTestNetwork(), calls)), liveKey, 'order:live-run:desk:1');
  // Through its file, as the stack keeps it.
  const recording = parseRecording(JSON.parse(JSON.stringify(traderRecording(calls, liveKey.address, 'TEST'))));
  return { recording, live };
}

describe('a recorded run of the venue journeys (hl-recorded)', () => {
  it('keeps every call with the trader as <trader>, no signature, and the address never the key', async () => {
    const { recording, live } = await record();
    expect(live.outcome.definite && live.outcome.accepted).toBe(true);
    const text = JSON.stringify(recording);
    expect(recording.trader).toBe('<trader>');
    expect(text).not.toContain(liveKey.address.toLowerCase().slice(2));
    expect(text).not.toContain('"signature"');
    expect(recording.calls.filter((c) => c.path === '/exchange')).toHaveLength(1);
  });

  it("drops each spot token's tokenId, which the adapter never reads and a secret scanner takes for a key, and keeps the rest", () => {
    const id = `0x${'ab'.repeat(16)}`;
    const token = { name: 'USDC', index: 0, szDecimals: 8, tokenId: id };
    const calls: HlRecordedCall[] = [
      {
        path: '/info',
        request: { type: 'spotMeta' },
        status: 200,
        answer: { tokens: [token], universe: [{ name: 'X', tokens: [0, 0], index: 0 }] },
        source: 'testnet',
      },
      {
        path: '/info',
        request: { type: 'spotMetaAndAssetCtxs' },
        status: 200,
        answer: [{ tokens: [token], universe: [] }, [{ markPx: '1' }]],
        source: 'testnet',
      },
      { path: '/info', request: { type: 'meta' }, status: 200, answer: { tokenId: id }, source: 'testnet' },
    ];
    const [spot, both, other] = traderRecording(calls, liveKey.address, 'TEST').calls.map((c) => c.answer);
    expect(spot).toEqual({ tokens: [{ name: 'USDC', index: 0, szDecimals: 8 }], universe: [{ name: 'X', tokens: [0, 0], index: 0 }] });
    expect(both).toEqual([{ tokens: [{ name: 'USDC', index: 0, szDecimals: 8 }], universe: [] }, [{ markPx: '1' }]]);
    expect(other).toEqual({ tokenId: id });
    expect(calls[0]!.answer).toEqual({ tokens: [token], universe: [{ name: 'X', tokens: [0, 0], index: 0 }] });
  });

  it('another wallet replaying the same steps gets the same answers, its own address and order id written in', async () => {
    const { recording, live } = await record();
    const fetch = replayRecording(recording, { trader: replayKey.address });
    const again = await steps(venueWith(fetch), replayKey, 'order:replay-run:desk:7');
    expect(again.cloid).not.toBe(live.cloid);
    expect(again.before).toEqual(live.before);
    expect(again.after).toEqual(live.after);
    expect(again.after.find((b) => b.asset === 'USDC')!.locked).toEqual(a('1000'));
    expect(again.outcome.definite && again.outcome.accepted).toBe(true);
    expect(again.open.map((o) => o.venueClientOrderId)).toEqual([venueClientOrderId(HL_TESTNET_VENUE_ID, 'order:replay-run:desk:7')]);
    expect(fetch.misses).toEqual([]);
  });

  it('a planted wrong balance in the recording is what the replay answers, so a step checking it fails', async () => {
    const { recording, live } = await record();
    const planted = JSON.parse(JSON.stringify(recording)) as HlRecording;
    const first = planted.calls.find((c) => (c.request as { type?: string }).type === 'spotClearinghouseState')!;
    (first.answer as { balances: { total: string }[] }).balances[0]!.total = '4999';
    const again = await steps(venueWith(replayRecording(planted, { trader: replayKey.address })), replayKey, 'order:replay-run:desk:8');
    expect(again.before).not.toEqual(live.before);
    expect(again.before.find((b) => b.asset === 'USDC')!.total).toEqual(a('4999'));
  });

  it('a write that is not the next recorded one, and a read never recorded, are refused and listed, never answered', async () => {
    const { recording } = await record();
    const fetch = replayRecording(recording, { trader: replayKey.address });
    const venue = venueWith(fetch);
    const account = accountOf(replayKey);
    // Another price is another write: refused, and the adapter reads its answer as lost (definite: false), never a fill.
    const prepared = await venue.prepare(account, { role: 'owner', address: account.owner }, order('order:replay-run:desk:9', '1999'));
    expect((await venue.submit(prepared, await sign(replayKey, prepared))).definite).toBe(false);
    await expect(venue.orderHistory(account)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    expect(fetch.misses.map((m) => m.path)).toEqual(['/exchange', '/info']);
    await expect(
      fetch('https://api.hyperliquid-testnet.xyz/info', {
        method: 'POST',
        headers: {},
        body: '{"type":"allMids"}',
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toBeInstanceOf(NotRecordedError);
  });

  it('a read answers the state its epoch settled on, however often it is asked; a read first recorded later has none', async () => {
    const { recording } = await record();
    const venue = venueWith(replayRecording(recording, { trader: replayKey.address }));
    const account = accountOf(replayKey);
    for (let i = 0; i < 3; i++) expect((await venue.balances(account)).value.find((b) => b.asset === 'USDC')!.locked).toEqual(a('0'));
    await expect(venue.openOrders(account)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
  });

  it("a recording made for <trader> refuses to replay without the run's trader address", async () => {
    const { recording } = await record();
    expect(() => replayRecording(recording)).toThrow(/needs the trader address/);
    expect(() => replayRecording(recording, { trader: 'not-an-address' })).toThrow(/needs the trader address/);
  });
});
