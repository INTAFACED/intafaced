import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataSigner, type FetchLike } from '../src/index.js';
import {
  ActivationRefusal,
  HL_MAINNET_API_URL,
  HL_TESTNET_DRIP_URL,
  MainnetOnce,
  mainnetSendAsset,
  runActivate,
} from './faucet-activate.js';

const NOW = Date.UTC(2026, 10, 27, 7, 0, 0);
/** TEST keys derived from labels. Never real keys. */
const FUNDER: Hex = keccak256(toHex('intafaced TEST hl activate funder'));
const FRESH: Hex = keccak256(toHex('intafaced TEST hl activate fresh'));
const FUNDER_ADDR = privateKeyToAccount(FUNDER).address.toLowerCase();
const FRESH_ADDR = privateKeyToAccount(FRESH).address.toLowerCase();
const MAIN_TOKEN = '0x6d1e7cde53ba9467b783cb7c530ce054';
const TEST_TOKEN = '0xeb62eee3685fc4c43992febcd9e75443';

interface NetOpts {
  mainFunder?: number;
  /** What mainnet's /exchange answers. */
  mainAnswer?: unknown;
  /** The venue's activation fee, charged to the sender. */
  fee?: number;
  /** Claims answered "does not exist on mainnet" before the faucet pays. */
  claimsBeforePay?: number;
  drip?: number;
}

function fakeNet(o: NetOpts = {}) {
  const main = new Map<string, number>([[FUNDER_ADDR, o.mainFunder ?? 5.91]]);
  const testSpot = new Map<string, number>([[FUNDER_ADDR, 199]]);
  const testPerps = new Map<string, number>();
  const mainSent: Record<string, unknown>[] = [];
  const testSent: Record<string, unknown>[] = [];
  let claims = 0;
  const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (url === `${HL_MAINNET_API_URL}/exchange`) {
      mainSent.push(body);
      const answer = o.mainAnswer ?? { status: 'ok', response: { type: 'default' } };
      if ((answer as { status?: string }).status === 'ok') {
        const a = body.action as Record<string, string>;
        main.set(a.destination!, (main.get(a.destination!) ?? 0) + Number(a.amount));
        main.set(FUNDER_ADDR, main.get(FUNDER_ADDR)! - Number(a.amount) - (o.fee ?? 1));
      }
      return ok(answer);
    }
    if (url === `${HL_MAINNET_API_URL}/info`) {
      if (body.type === 'spotMeta') return ok({ tokens: [{ name: 'USDC', tokenId: MAIN_TOKEN, index: 0 }] });
      if (body.type === 'spotClearinghouseState') {
        const have = main.get(String(body.user));
        return ok({ balances: have === undefined ? [] : [{ coin: 'USDC', total: String(have), hold: '0.0' }] });
      }
    }
    if (url === HL_TESTNET_DRIP_URL && body.type === 'claimDrip') {
      claims += 1;
      if (!main.has(String(body.user)) || claims <= (o.claimsBeforePay ?? 0)) return ok('User does not exist on mainnet');
      testPerps.set(String(body.user), o.drip ?? 1000);
      return ok({ status: 'ok' });
    }
    if (url.endsWith('/exchange')) {
      testSent.push(body);
      const a = body.action as Record<string, string>;
      testPerps.set(FRESH_ADDR, (testPerps.get(FRESH_ADDR) ?? 0) - Number(a.amount));
      testSpot.set(a.destination!, (testSpot.get(a.destination!) ?? 0) + Number(a.amount));
      return ok({ status: 'ok', response: { type: 'default' } });
    }
    if (url.endsWith('/info')) {
      if (body.type === 'userAbstraction') return ok(String(body.user) === FUNDER_ADDR ? 'unifiedAccount' : 'default');
      if (body.type === 'clearinghouseState') return ok({ withdrawable: String(testPerps.get(String(body.user)) ?? 0) });
      if (body.type === 'spotMeta') return ok({ tokens: [{ name: 'USDC', tokenId: TEST_TOKEN, index: 0 }] });
      if (body.type === 'spotClearinghouseState') {
        const have = testSpot.get(String(body.user));
        return ok({ balances: have === undefined ? [] : [{ coin: 'USDC', total: String(have), hold: '0.0' }] });
      }
    }
    throw new Error(`unexpected ${url} ${String(body.type)}`);
  };
  return { fetch, main, testSpot, mainSent, testSent, claims: () => claims };
}

async function run(env: Record<string, string | undefined>, net = fakeNet()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runActivate({
    env: { APP_ENV: 'test', HL_TESTNET_FUNDER_KEY: FUNDER, HL_ACTIVATIONS_TODAY: '0', ...env },
    fetch: net.fetch,
    clock: () => new Date(NOW),
    sleep: async () => {},
    freshKey: FRESH,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, net, text: [...out, ...err].join('\n') };
}

describe('faucet:activate', () => {
  it('sends one cent on mainnet, claims the drip and moves all of it to the funder on the testnet', async () => {
    const r = await run({}, fakeNet({ claimsBeforePay: 1 }));
    expect(r.code).toBe(0);
    expect(r.net.mainSent).toHaveLength(1);
    const body = r.net.mainSent[0] as { action: Record<string, unknown>; nonce: number; signature: { r: string; s: string; v: number } };
    expect(body.action).toMatchObject({
      type: 'sendAsset',
      hyperliquidChain: 'Mainnet',
      destination: FRESH_ADDR,
      sourceDex: 'spot',
      destinationDex: 'spot',
      token: `USDC:${MAIN_TOKEN}`,
      amount: '0.01',
    });
    const { typedData } = mainnetSendAsset(FRESH_ADDR, `USDC:${MAIN_TOKEN}`, '0.01', BigInt(body.nonce));
    const joined = `${body.signature.r}${body.signature.s.slice(2)}${body.signature.v.toString(16)}`;
    expect(await recoverTypedDataSigner(typedData, joined)).toBe(FUNDER_ADDR);
    expect(r.net.testSent).toHaveLength(1);
    expect((r.net.testSent[0] as { action: Record<string, unknown> }).action).toMatchObject({
      type: 'usdSend',
      hyperliquidChain: 'Testnet',
      destination: FUNDER_ADDR,
      amount: '1000',
    });
    expect(r.net.testSpot.get(FUNDER_ADDR)).toBe(1199);
    expect(r.text).toContain('spent 1.01 (cap 1.02)');
    expect(r.text).toContain('after: funder 1199 TEST USDC on the testnet (was 199)');
  });

  it('never prints either key', async () => {
    const r = await run({});
    expect(r.text).not.toContain(FUNDER.slice(2));
    expect(r.text).not.toContain(FRESH.slice(2));
  });

  it('refuses a second mainnet action in one run, before anything is sent', async () => {
    const net = fakeNet();
    const once = new MainnetOnce(net.fetch);
    const funder = privateKeyToAccount(FUNDER);
    await once.send(funder, FRESH_ADDR, `USDC:${MAIN_TOKEN}`, '0.01', 1n);
    await expect(once.send(funder, FRESH_ADDR, `USDC:${MAIN_TOKEN}`, '0.01', 2n)).rejects.toThrow(ActivationRefusal);
    expect(net.mainSent).toHaveLength(1);
  });

  it('refuses a mainnet send over the cap, before anything is sent', async () => {
    const net = fakeNet();
    const once = new MainnetOnce(net.fetch);
    await expect(once.send(privateKeyToAccount(FUNDER), FRESH_ADDR, `USDC:${MAIN_TOKEN}`, '0.02', 1n)).rejects.toThrow('above the cap');
    expect(net.mainSent).toHaveLength(0);
  });

  it.each([
    ['an amount over the cap', { HL_ACTIVATE_AMOUNT: '0.02' }, 'above the cap of 0.01'],
    ['a whole dollar', { HL_ACTIVATE_AMOUNT: '1' }, 'above the cap of 0.01'],
    ['a third run today', { HL_ACTIVATIONS_TODAY: '2' }, 'at most 2 a day'],
    ['no run count', { HL_ACTIVATIONS_TODAY: undefined }, 'HL_ACTIVATIONS_TODAY must be'],
    ['no key', { HL_TESTNET_FUNDER_KEY: undefined }, 'HL_TESTNET_FUNDER_KEY is not set'],
    ['a bad key', { HL_TESTNET_FUNDER_KEY: '0x1234' }, 'not a 32-byte hex key'],
    ['APP_ENV production', { APP_ENV: 'production' }, 'refused'],
  ])('refuses %s with exit 2 and sends nothing', async (_label, env, words) => {
    const r = await run(env);
    expect(r.code).toBe(2);
    expect(r.net.mainSent).toHaveLength(0);
    expect(r.net.testSent).toHaveLength(0);
    expect(r.text).toContain(words);
  });

  it('refuses when the mainnet account holds less than the most a run may spend', async () => {
    const r = await run({}, fakeNet({ mainFunder: 1.01 }));
    expect(r.code).toBe(1);
    expect(r.net.mainSent).toHaveLength(0);
    expect(r.text).toContain('under 1.02');
  });

  it('stops on a mainnet refusal, claiming nothing and trying no other form', async () => {
    const net = fakeNet({ mainAnswer: { status: 'err', response: 'Insufficient balance' } });
    const r = await run({}, net);
    expect(r.code).toBe(1);
    expect(net.mainSent).toHaveLength(1);
    expect(net.claims()).toBe(0);
    expect(net.testSent).toHaveLength(0);
  });

  it('exits 1 and names it when the mainnet spend goes over its cap', async () => {
    const r = await run({}, fakeNet({ fee: 1.5 }));
    expect(r.code).toBe(1);
    expect(r.text).toContain('the mainnet spend 1.51 is over the cap of 1.02');
  });

  it('exits 1 when the faucet never pays, sending nothing on the testnet', async () => {
    const net = fakeNet({ claimsBeforePay: 99 });
    const r = await run({}, net);
    expect(r.code).toBe(1);
    expect(net.testSent).toHaveLength(0);
    expect(r.text).toContain('the faucet paid');
  });
});
