import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { HyperliquidTestnetUserVenue, recoverTypedDataSigner, usdSendAction, type FetchLike } from '../src/index.js';
import { probePriceFar, resolveProbe, resolveSpot, sizeForValue, spotPriceInside } from './live-settings.js';
import { runSetup, sendFor, usdcNeeded } from './testnet-setup.js';

const a = parseAmount;
const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
/** TEST keys derived from a label. Never a real key. */
const testKey = (label: string) => keccak256(toHex(`intafaced TEST hl setup ${label}`));
const TRADER = testKey('trader');
const OTHER = testKey('other');
const addr = (key: Hex) => privateKeyToAccount(key).address.toLowerCase();

const META = { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] };
const SPOT_META = {
  tokens: [
    { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0 },
    { name: 'HYPE', szDecimals: 2, weiDecimals: 8, index: 1 },
    { name: 'PURR', szDecimals: 0, weiDecimals: 5, index: 2 },
  ],
  universe: [
    { name: '@1', tokens: [1, 0], index: 1, isCanonical: false },
    { name: 'PURR/USDC', tokens: [2, 0], index: 0, isCanonical: true },
  ],
};

interface Holding {
  perp: string;
  spot: string;
}

function fakeNet(holdings: Map<string, Holding>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const books: Record<string, unknown> = {
    '@1': { coin: '@1', time: NOW, levels: [[{ px: '150.1', sz: '3', n: 1 }], [{ px: '150.9', sz: '2', n: 1 }]] },
    'PURR/USDC': { coin: 'PURR/USDC', time: NOW, levels: [[{ px: '0.2', sz: '100', n: 1 }], [{ px: '0.2001', sz: '100', n: 1 }]] },
    ETH: { coin: 'ETH', time: NOW, levels: [[{ px: '2000', sz: '1', n: 1 }], [{ px: '2001', sz: '1', n: 1 }]] },
  };
  const of = (user: string): Holding => holdings.get(user) ?? { perp: '0', spot: '0' };
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
    if (url.endsWith('/exchange')) {
      const action = body.action as Record<string, string>;
      if (action.type === 'usdSend') {
        const sender = [...holdings.keys()].find((k) => k === addr(TRADER))!;
        const to = of(action.destination!);
        holdings.set(action.destination!, { ...to, perp: String(Number(to.perp) + Number(action.amount)) });
        const from = of(sender);
        holdings.set(sender, { ...from, perp: String(Number(from.perp) - Number(action.amount)) });
      }
      return ok({ status: 'ok', response: { type: 'default' } });
    }
    switch (body.type) {
      case 'meta':
        return ok(META);
      case 'spotMeta':
        return ok(SPOT_META);
      case 'allMids':
        return ok({ ETH: '2000.5', '@1': '150.5', 'PURR/USDC': '0.20005' });
      case 'l2Book':
        return ok(books[String(body.coin)]);
      case 'clearinghouseState': {
        const h = of(String(body.user));
        return ok({ marginSummary: { accountValue: h.perp }, withdrawable: h.perp, assetPositions: [], time: NOW });
      }
      case 'spotClearinghouseState': {
        const h = of(String(body.user));
        return ok({ balances: h.spot === '0' ? [] : [{ coin: 'USDC', token: 0, total: h.spot, hold: '0' }] });
      }
      default:
        return { ok: false, status: 400, text: async () => 'unknown' };
    }
  };
  return { fetch, calls, exchange: () => calls.filter((c) => c.url.endsWith('/exchange')) };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hl-setup-test-'));
  file = join(dir, 'keys.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  env: Record<string, string | undefined>,
  holdings = new Map<string, Holding>([[addr(TRADER), { perp: '1000', spot: '0' }]]),
) {
  const net = fakeNet(holdings);
  const lines: string[] = [];
  const code = await runSetup({
    env: { APP_ENV: 'test', HL_TESTNET_KEY_FILE: file, ...env },
    fetch: net.fetch,
    clock: () => new Date(NOW),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { code, printed: lines.join('\n'), net, holdings };
}

/** Every 64-hex run in the key file, so a test can assert none was printed, with or without 0x, in any case. */
function keysIn(path: string): string[] {
  return [...readFileSync(path, 'utf8').matchAll(/[0-9a-fA-F]{64}/g)].map((m) => m[0].toLowerCase());
}
function expectNoKeyPrinted(printed: string, keys: string[]) {
  expect(keys.length).toBeGreaterThan(0);
  const lower = printed.toLowerCase();
  for (const k of keys) expect(lower.includes(k)).toBe(false);
}

describe('testnet setup: the key file', () => {
  it('adds the missing keys and keeps the existing ones byte-for-byte', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER.toUpperCase().replace('0X', '0x'), other: OTHER, note: 'TEST' }));
    const before = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const { code } = await run({});
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(after.trader).toBe(before.trader);
    expect(after.other).toBe(before.other);
    expect(after.note).toBe('TEST');
    for (const k of ['agent', 'third']) expect(after[k]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set([after.trader!.toLowerCase(), after.agent, after.other, after.third]).size).toBe(4);
  });

  it('a second run replaces nothing and leaves the file as it is', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    await run({});
    const first = readFileSync(file, 'utf8');
    const { code, printed } = await run({});
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(printed).toContain('file unchanged');
  });

  it('writes the file with mode 0600 through a temp file it leaves no trace of', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    chmodSync(file, 0o644);
    await run({});
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['keys.json']);
  });

  it('prints no key, on stdout or stderr: only addresses', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    const { printed } = await run({});
    const keys = keysIn(file);
    expect(keys).toHaveLength(4);
    expectNoKeyPrinted(printed, keys);
    expect(printed).toContain(addr(TRADER));
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Hex>;
    for (const k of ['agent', 'other', 'third']) expect(printed).toContain(addr(written[k]!));
    // Belt and braces: nothing 64-hex long at all.
    expect(printed).not.toMatch(/[0-9a-fA-F]{64}/);
  });

  const SECRETISH = `0x${'ab'.repeat(32)}`;
  const bad: [string, string][] = [
    ['not JSON', `{"trader": "${SECRETISH}",`],
    ['an array', `["${SECRETISH}"]`],
    ['no trader', JSON.stringify({ other: SECRETISH })],
    ['a 31-byte trader', JSON.stringify({ trader: `0x${'ab'.repeat(31)}`, other: SECRETISH })],
    ['a trader with no 0x', JSON.stringify({ trader: 'ab'.repeat(32) })],
    ['a zero trader key', JSON.stringify({ trader: `0x${'00'.repeat(32)}`, other: SECRETISH })],
    ['a malformed other', JSON.stringify({ trader: SECRETISH, other: `0x${'cd'.repeat(30)}` })],
  ];
  for (const [what, content] of bad) {
    it(`refuses ${what} with exit 2, without echoing it, and changes nothing`, async () => {
      writeFileSync(file, content);
      const { code, printed, net } = await run({});
      expect(code).toBe(2);
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(net.calls).toHaveLength(0);
      expect(printed).toMatch(/refused/);
      expect(printed.toLowerCase()).not.toContain('abababab');
      expect(printed.toLowerCase()).not.toContain('cdcdcdcd');
      expect(printed).not.toContain(content);
    });
  }

  it('refuses a missing file and an unset path with exit 2', async () => {
    expect((await run({})).code).toBe(2);
    expect((await run({ HL_TESTNET_KEY_FILE: undefined })).code).toBe(2);
  });
});

describe('testnet setup: funding other and third', () => {
  it('signs usdSend on the testnet chain, and the signature recovers the trader', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    const { code, net } = await run({});
    expect(code).toBe(0);
    const keys = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Hex>;
    const sends = net.exchange().map((c) => c.body);
    expect(sends.map((b) => (b.action as Record<string, unknown>).destination)).toEqual([addr(keys.other!), addr(keys.third!)]);
    for (const body of sends) {
      const action = body.action as Record<string, string | number>;
      expect(action.type).toBe('usdSend');
      expect(action.hyperliquidChain).toBe('Testnet');
      expect(action.signatureChainId).toBe('0x66eee');
      expect(action.time).toBe(body.nonce);
      expect(action.amount).toBe('2'); // the 1 USDC floor, plus the 1 USDC cushion
      const { typedData } = usdSendAction(String(action.destination), String(action.amount), BigInt(body.nonce as number));
      expect(typedData.domain.chainId).toBe(421614);
      const sig = body.signature as { r: Hex; s: Hex; v: number };
      const joined = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}`;
      expect(await recoverTypedDataSigner(typedData, joined)).toBe(addr(TRADER));
    }
    // The two sends draw distinct nonces from the adapter's nonce source.
    expect(new Set(sends.map((b) => b.nonce)).size).toBe(2);
  });

  it('an account that already holds enough gets no send', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER, other: OTHER }));
    const holdings = new Map<string, Holding>([
      [addr(TRADER), { perp: '1000', spot: '0' }],
      [addr(OTHER), { perp: '5', spot: '0' }],
    ]);
    const { code, net } = await run({}, holdings);
    expect(code).toBe(0);
    const destinations = net.exchange().map((c) => (c.body.action as Record<string, unknown>).destination);
    expect(destinations).not.toContain(addr(OTHER));
    expect(destinations).toHaveLength(1); // third only
    // A re-run finds both funded and sends nothing.
    const again = await run({}, holdings);
    expect(again.net.exchange()).toHaveLength(0);
    expect(again.printed).toContain('send: none');
  });

  it('a trader short of the sends refuses them with exit 1', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    const { code, net, printed } = await run({}, new Map([[addr(TRADER), { perp: '3', spot: '0' }]]));
    expect(code).toBe(1);
    expect(net.exchange()).toHaveLength(0);
    expect(printed).toMatch(/send: refused/);
  });

  it('prints each role before and after, and what the suite will still find short', async () => {
    writeFileSync(file, JSON.stringify({ trader: TRADER }));
    const { printed } = await run({});
    expect(printed).toMatch(/trader +0x[0-9a-f]{40} {2}0 -> 0 {4}1000 -> 996/);
    expect(printed).toMatch(/other +0x[0-9a-f]{40} {2}0 -> 0 {4}0 -> 2/);
    expect(printed).toContain('still short for the suite: trader holds 0 spot USDC free');
    expect(printed).toContain('still short for the suite: other holds 0 HYPE free');
    expect(printed).toContain('spot market for the suite: HYPE-USDC (derived), price 150.5 (derived), size 0.08 (derived)');
  });

  it('needs: the floor while the runner runs no perp checks, the suite figure when it does', () => {
    expect(usdcNeeded()).toBe(a('1'));
    expect(usdcNeeded({ symbol: 'ETH-PERP' })).toBe(a('100000'));
    expect(sendFor(a('0'), a('1'))).toBe(a('2'));
    expect(sendFor(a('0.5'), a('1'))).toBe(a('1.5'));
    expect(sendFor(a('1'), a('1'))).toBe(a('0'));
  });
});

describe('testnet setup: mainnet refused', () => {
  for (const [what, env] of [
    ['a mainnet URL', { HL_API_URL: 'https://api.hyperliquid.xyz' }],
    ['APP_ENV production', { APP_ENV: 'production' }],
    ['APP_ENV unset', { APP_ENV: undefined }],
  ] as const) {
    it(`${what}: exit 2 before the file is read or anything is sent`, async () => {
      writeFileSync(file, JSON.stringify({ trader: TRADER }));
      const before = readFileSync(file, 'utf8');
      const { code, net, printed } = await run(env);
      expect(code).toBe(2);
      expect(net.calls).toHaveLength(0);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(printed).toMatch(/refused/);
    });
  }

  it('the usdSend builder refuses anything but the testnet chain', () => {
    expect(() => usdSendAction(addr(OTHER), '1', 1n)).not.toThrow();
    // userSignedTypedData under it refuses "Mainnet" (signing.test.ts); the builder fixes "Testnet".
    expect(usdSendAction(addr(OTHER), '1', 1n).typedData.message.hyperliquidChain).toBe('Testnet');
  });
});

describe('runner settings derived from the live book', () => {
  const venue = (holdings = new Map<string, Holding>()) =>
    new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch: fakeNet(holdings).fetch, clock: () => new Date(NOW) });

  it('picks a USDC spot pair above 100, a price strictly inside its spread, and an 11 USDC size', async () => {
    const spot = await resolveSpot(venue(), {});
    expect([spot.symbol, spot.price, spot.size]).toEqual([
      { value: 'HYPE-USDC', source: 'derived' },
      { value: a('150.5'), source: 'derived' },
      { value: a('0.08'), source: 'derived' }, // 11 / 150.5 = 0.0731 -> 0.08 at 2 decimals
    ]);
    expect([spot.base, spot.quote]).toEqual(['HYPE', 'USDC']);
  });

  it('explicit settings win and are used as given', async () => {
    const spot = await resolveSpot(venue(), { HL_SPOT_SYMBOL: 'HYPE-USDC', HL_SPOT_PRICE: '150.2', HL_SPOT_SIZE: '1' });
    expect([spot.symbol.source, spot.price, spot.size]).toEqual([
      'set',
      { value: a('150.2'), source: 'set' },
      { value: a('1'), source: 'set' },
    ]);
    const probe = await resolveProbe(venue(), { HL_PROBE_SYMBOL: 'ETH-PERP', HL_PROBE_PRICE: '1000', HL_PROBE_SIZE: '0.01' });
    expect([probe.price.value, probe.size.value, probe.price.source]).toEqual([a('1000'), a('0.01'), 'set']);
  });

  it('a named pair below 100 is refused with a reason, not traded at a bad price', async () => {
    await expect(resolveSpot(venue(), { HL_SPOT_SYMBOL: 'PURR-USDC' })).rejects.toThrow(/price - 100/);
  });

  it('the probe defaults to ETH-PERP at 60 percent of the best bid', async () => {
    const probe = await resolveProbe(venue(), {});
    expect([probe.symbol.value, probe.price.value, probe.size.value]).toEqual(['ETH-PERP', a('1200'), a('0.0092')]);
  });

  it('price helpers: inside the spread, one percent past a one-sided book, valid ticks, never at the touch', () => {
    const m = { symbol: 'X-USDC', kind: 'spot' as const, szDecimals: 2, base: 'X', quote: 'USDC' };
    const book = (bids: string[], asks: string[]) => ({
      symbol: 'X-USDC',
      bids: bids.map((p) => ({ price: a(p), size: a('1') })),
      asks: asks.map((p) => ({ price: a(p), size: a('1') })),
    });
    expect(spotPriceInside(book(['150.1'], ['150.9']), m)).toBe(a('150.5'));
    expect(spotPriceInside(book(['200'], []), m)).toBe(a('202'));
    expect(spotPriceInside(book([], ['200']), m)).toBe(a('198'));
    // One tick apart at 5 significant figures: no room inside.
    expect(spotPriceInside(book(['150.11'], ['150.12']), m)).toBeNull();
    // 987.65 + 100 has six significant figures: the next coarser valid price is chosen.
    expect(spotPriceInside(book(['987.5'], ['987.8']), m)).toBe(a('987.6'));
    expect(spotPriceInside(book([], []), m)).toBeNull();
    expect(probePriceFar(book(['2000.5'], []), { ...m, kind: 'perpetual', szDecimals: 4 })).toBe(a('1200.3'));
    expect(sizeForValue(a('0.2'), 0)).toBe(a('55'));
  });
});
