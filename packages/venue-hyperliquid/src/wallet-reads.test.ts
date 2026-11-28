import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from './core.js';
import { answerUserVenue, HL_TESTNET_WALLET_CHAIN_ID, startHyperliquidVenueServer } from './http-server.js';
import { parseRecording, replayRecording } from './recorded.js';
import { loadOrderRecording, RECORDED_ORDER_ACCOUNT, RECORDED_ORDER_NOW_MS } from './recorded-order.js';
import { HL_TESTNET_API_URL } from './signing.js';
import { HyperliquidTestnetUserVenue } from './venue.js';
import { HyperliquidWalletReads } from './wallet-reads.js';

// A person's own fills, balances and positions are read from their own browser. The browser's reader parses the
// venue's answers with the server's own code, so the desk sees the same figures; and only the live server names it.

const TRADER = '0x00000000000000000000000000000000000000ab';
const recording = (file: string) => parseRecording(JSON.parse(fs.readFileSync(new URL(`../recordings/${file}`, import.meta.url), 'utf8')));
const desk = recording('J-derivatives-01-hl-venue.json');
// A non-unified account with perp margin and no spot balance, whose two reads the daily recording no longer holds:
// kept from the 27 Nov live recording, so the parity still covers that account's shape.
const OTHER = '0x116d8f7751e72306d499dd61ae826e46a726c632';
const perpMargin = parseRecording(JSON.parse(fs.readFileSync(new URL('./fixtures/perp-margin-account.json', import.meta.url), 'utf8')));
// J-derivatives-03's live run opens a position and closes it with its last order: every read answered before that
// close holds it open, so the parity covers a live position.
const run = recording('J-derivatives-03-hl-venue.json').calls;
const closing = run.findLastIndex((c) => (c.request as { action?: { type?: string } }).action?.type === 'order');
const opened = run.slice(0, closing);

/** Every URL a reader asked, so a test can see where its reads went. */
function asked(fetch: FetchLike) {
  const urls: string[] = [];
  const wrapped: FetchLike = (input, init) => {
    urls.push(input);
    return fetch(input, init);
  };
  return { urls, fetch: wrapped };
}

describe('HyperliquidWalletReads (the browser reader)', () => {
  it('reads balances and positions as the venue server does, at the test network only', async () => {
    const seen: string[] = [];
    for (const [owner, from] of [
      [TRADER, desk],
      [OTHER, perpMargin],
    ] as const) {
      const server = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: replayRecording(from, { trader: TRADER }) });
      const reads = asked(replayRecording(from, { trader: TRADER }));
      const browser = new HyperliquidWalletReads({ fetch: reads.fetch, warn: () => {} });
      const account = { venueId: 'hyperliquid-testnet', owner, subAccount: null };
      expect((await browser.balances(account)).value, owner).toEqual((await server.balances(account)).value);
      expect((await browser.positions(account)).value, owner).toEqual((await server.positions(account)).value);
      seen.push(...reads.urls);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([`${HL_TESTNET_API_URL}/info`]));
  });

  it('reads an open position and its margin as the venue server does', async () => {
    // Answered by each request's own body with its last answer before the close.
    const latest: FetchLike = async (_input, init) => {
      const body = JSON.stringify(JSON.parse(String(init?.body)));
      const call = opened.findLast((c) => JSON.stringify(c.request).replaceAll('<trader>', TRADER) === body);
      if (!call) throw new Error(`no recorded answer for ${body}`);
      const text = JSON.stringify(call.answer).replaceAll('<trader>', TRADER);
      return { ok: true, status: 200, text: async () => text };
    };
    const server = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: latest });
    const browser = new HyperliquidWalletReads({ fetch: latest, warn: () => {} });
    const account = { venueId: 'hyperliquid-testnet', owner: TRADER, subAccount: null };
    const positions = (await browser.positions(account)).value;
    expect(positions).toHaveLength(1);
    expect(positions).toEqual((await server.positions(account)).value);
    expect((await browser.balances(account)).value).toEqual((await server.balances(account)).value);
  });

  it("reads the account's fills as the venue server does", async () => {
    // Answered by each request's own body, in any order: the recording's order is the server's run, not this read's.
    const calls = loadOrderRecording().calls;
    const byBody: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const call = calls.find((c) => JSON.stringify(c.request) === JSON.stringify(body));
      if (!call) throw new Error(`no recorded answer for ${String(init?.body)}`);
      return new Response(JSON.stringify(call.answer), { status: 200 });
    };
    const clock = () => new Date(RECORDED_ORDER_NOW_MS);
    const server = new HyperliquidTestnetUserVenue({ appEnv: 'test', clock, fetch: byBody });
    const browser = new HyperliquidWalletReads({ clock, fetch: byBody, warn: () => {} });
    const since = new Date(RECORDED_ORDER_NOW_MS);
    const fromBrowser = await browser.fills(RECORDED_ORDER_ACCOUNT, since);
    expect(fromBrowser.value).toHaveLength(1);
    expect(fromBrowser.value).toEqual((await server.fills(RECORDED_ORDER_ACCOUNT, since)).value);
  });

  it('holds no signing: it has no prepare or submit', () => {
    const browser = new HyperliquidWalletReads({ fetch: replayRecording(desk, { trader: TRADER }), warn: () => {} });
    expect('submit' in browser).toBe(false);
    expect('prepare' in browser).toBe(false);
  });
});

describe('GET /venue names the browser reads only on the live test network', () => {
  it('a server answering from a recording names none: every read comes through it', async () => {
    const replayed = await startHyperliquidVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      fetch: replayRecording(loadOrderRecording()),
    });
    try {
      const body = (await (await fetch(`${replayed.url}/venue`)).json()) as Record<string, unknown>;
      expect(body.chainId).toBe(HL_TESTNET_WALLET_CHAIN_ID);
      expect(body).not.toHaveProperty('walletReads');
    } finally {
      replayed.server.close();
    }
  });

  it('the live server names the test network and its perp DEXs', async () => {
    const live = await startHyperliquidVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', perpDexs: ['xyz'] });
    try {
      const body = (await (await fetch(`${live.url}/venue`)).json()) as Record<string, unknown>;
      expect(body.walletReads).toEqual({ baseUrl: 'https://api.hyperliquid-testnet.xyz', perpDexs: ['xyz'] });
    } finally {
      live.server.close();
    }
  });

  it('a venue answered without wallet reads names none', async () => {
    const venue = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: replayRecording(loadOrderRecording()) });
    const [, body] = await answerUserVenue(venue, { chainId: 1, deposit: null }, { method: 'GET', path: '/venue', rawBody: '' });
    expect(body).not.toHaveProperty('walletReads');
  });
});
