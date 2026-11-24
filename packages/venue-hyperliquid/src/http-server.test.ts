import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { encodeVenueWire, USER_VENUE_READS } from '@intafaced/venue-contracts';
import { answerUserVenue, HL_TESTNET_WALLET_CHAIN_ID, startHyperliquidVenueServer } from './http-server.js';
import { NotRecordedError, parseRecording, replayRecording } from './recorded.js';
import { loadOrderRecording, RECORDED_ORDER_ACCOUNT, RECORDED_ORDER_NOW_MS, runRecordedOrder } from './recorded-order.js';
import { HyperliquidTestnetUserVenue } from './venue.js';

const recorded = () =>
  new HyperliquidTestnetUserVenue({
    appEnv: 'test',
    fetch: replayRecording(loadOrderRecording()),
    clock: () => new Date(RECORDED_ORDER_NOW_MS),
  });
const info = { chainId: HL_TESTNET_WALLET_CHAIN_ID, deposit: null };
const post = (venue: HyperliquidTestnetUserVenue, path: string, body: unknown) =>
  answerUserVenue(venue, info, { method: 'POST', path, rawBody: JSON.stringify(encodeVenueWire(body)) });

describe('the recorded TEST order (hl-recorded)', () => {
  it('replays in process: the order is accepted, reads back filled, and its one fill is at the recorded book price', async () => {
    const run = await runRecordedOrder(recorded());
    expect(run.outcome.definite && run.outcome.accepted).toBe(true);
    expect(run.order.value?.status).toBe('filled');
    expect(run.fills.value).toHaveLength(1);
    const [fill] = run.fills.value;
    expect([fill!.symbol, fill!.side, formatAmount(fill!.amount), fill!.venueClientOrderId, fill!.role]).toEqual([
      'BTC-PERP',
      'buy',
      '0.001',
      run.prepared.venueClientOrderId,
      'taker',
    ]);
    const book = loadOrderRecording().calls.find((c) => (c.request as { type?: string }).type === 'l2Book')!;
    const bestAsk = (book.answer as { levels: [unknown, { px: string }[]] }).levels[1][0]!.px;
    expect(formatAmount(fill!.price)).toBe(formatAmount(parseAmount(bestAsk)));
  });

  it('a recording must be labelled TEST, and a request it has no answer for is no answer, never a made-up one', async () => {
    expect(() => parseRecording({ ...loadOrderRecording(), label: 'LIVE' })).toThrow(/TEST/);
    const fetch = replayRecording({ label: 'TEST', note: '', calls: [] });
    await expect(
      fetch('https://api.hyperliquid-testnet.xyz/info', {
        method: 'POST',
        headers: {},
        body: '{"type":"meta"}',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toBeInstanceOf(NotRecordedError);
    const venue = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch });
    const [status, body] = await post(venue, '/markets', { account: null });
    expect(status).toBe(422);
    expect((body as { refusal: { code: string } }).refusal.code).toBe('venue_down');
  });
});

describe('the venue protocol over HTTP (answerUserVenue)', () => {
  it('GET /venue names the descriptor, the wallet chain and no deposit route; every read in USER_VENUE_READS has a route', async () => {
    const venue = recorded();
    const [status, body] = await answerUserVenue(venue, info, { method: 'GET', path: '/venue', rawBody: '' });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      label: 'TEST',
      chainId: 421_614,
      deposit: null,
      venue: { id: 'hyperliquid-testnet', proofLevel: 'partner-sandbox' },
    });
    for (const spec of Object.values(USER_VENUE_READS)) {
      const [s] = await post(venue, spec.path, { account: RECORDED_ORDER_ACCOUNT });
      expect(s, spec.path).not.toBe(404);
    }
  });

  it('a read the adapter does not offer is a typed not_offered refusal; an unknown path 404; a body that is not an object 400', async () => {
    const venue = recorded();
    const [s, body] = await post(venue, '/vaults', {});
    expect(s).toBe(422);
    expect((body as { refusal: { code: string } }).refusal.code).toBe('not_offered');
    expect((await post(venue, '/nowhere', {}))[0]).toBe(404);
    expect((await answerUserVenue(venue, info, { method: 'POST', path: '/markets', rawBody: '[1]' }))[0]).toBe(400);
    expect((await answerUserVenue(venue, info, { method: 'GET', path: '/markets', rawBody: '' }))[0]).toBe(405);
  });

  it('listens on loopback only, and refuses outside APP_ENV dev or test and the beta posture', async () => {
    await expect(startHyperliquidVenueServer({ host: '0.0.0.0', port: 0, appEnv: 'test' })).rejects.toThrow(/loopback/);
    await expect(startHyperliquidVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'production' })).rejects.toMatchObject({
      refusal: { code: 'test_venue_outside_test' },
    });
  });
});

describe('a running venue names its source and lists its replay misses', () => {
  it('/health names the recording and trader; /replay/misses lists each request the recording had no answer for', async () => {
    const fetch = replayRecording({ label: 'TEST', note: '', calls: [] });
    const source = { kind: 'hl-recorded' as const, recording: 'J-x', trader: `0x${'ab'.repeat(20)}`, misses: () => fetch.misses };
    const venue = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch });
    const at = { ...info, source };
    const [, health] = await answerUserVenue(venue, at, { method: 'GET', path: '/health', rawBody: '' });
    expect(health).toMatchObject({ source: { kind: 'hl-recorded', recording: 'J-x', trader: source.trader } });
    expect(await answerUserVenue(venue, at, { method: 'GET', path: '/replay/misses', rawBody: '' })).toEqual([200, { misses: [] }]);
    await answerUserVenue(venue, at, { method: 'POST', path: '/markets', rawBody: '{}' });
    const [status, body] = await answerUserVenue(venue, at, { method: 'GET', path: '/replay/misses', rawBody: '' });
    expect(status).toBe(200);
    // The market list reads the perpetual and spot listings: both are listed, each by its key.
    expect((body as { misses: { key: string }[] }).misses.map((m) => m.key).sort()).toEqual([
      '/info {"type":"meta"}',
      '/info {"type":"spotMeta"}',
    ]);
  });
});

describe('a user-signed action as the running venue sends it to the wallet', () => {
  it('the typed data names the wallet chain GET /venue names, and its uint64 nonce travels as a decimal string', async () => {
    const owner = `0x${'ab'.repeat(20)}`;
    const { server, url } = await startHyperliquidVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      fetch: replayRecording({ label: 'TEST', note: '', calls: [] }),
      clock: () => new Date(RECORDED_ORDER_NOW_MS),
    });
    try {
      const res = await fetch(`${url}/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          encodeVenueWire({
            account: { venueId: 'hyperliquid-testnet', owner, subAccount: null },
            signer: { kind: 'owner', address: owner },
            intent: { kind: 'approve_builder_fee', builder: `0x${'cd'.repeat(20)}`, maxFeeBps: parseAmount('0.5') },
          }),
        ),
      });
      expect(res.status).toBe(200);
      const prepared = (await res.json()) as { typedData: { domain: { chainId: number }; message: { nonce: unknown } } };
      expect(prepared.typedData.domain.chainId).toBe(HL_TESTNET_WALLET_CHAIN_ID);
      expect(prepared.typedData.message.nonce).toMatch(/^\d+$/);
      // The server is still up after the answer: a second request is answered.
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
