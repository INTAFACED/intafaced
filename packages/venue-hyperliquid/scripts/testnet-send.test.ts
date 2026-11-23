import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataSigner, spotSendAction, type FetchLike } from '../src/index.js';
import { runSend } from './testnet-send.js';

const NOW = Date.UTC(2026, 10, 23, 0, 0, 0);
/** A TEST key derived from a label. Never a real key. */
const FUNDER: Hex = keccak256(toHex('intafaced TEST hl send funder'));
const FUNDER_ADDR = privateKeyToAccount(FUNDER).address.toLowerCase();
const TO = '0xdeafb9ffaf6dc6dafe1c8d954741475a93dc5040';
const TOKEN_ID = '0xeb62eee3685fc4c43992febcd9e75443';

function fakeNet(spot: Map<string, number>, exchangeAnswer: unknown = { status: 'ok', response: { type: 'default' } }) {
  const sent: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
    if (url.endsWith('/exchange')) {
      const action = body.action as Record<string, string>;
      sent.push(body);
      if ((exchangeAnswer as { status?: string }).status === 'ok' && action.type === 'spotSend') {
        spot.set(action.destination!, (spot.get(action.destination!) ?? 0) + Number(action.amount));
        spot.set(FUNDER_ADDR, (spot.get(FUNDER_ADDR) ?? 0) - Number(action.amount));
      }
      return ok(exchangeAnswer);
    }
    if (body.type === 'spotMeta') return ok({ tokens: [{ name: 'USDC', tokenId: TOKEN_ID, index: 0 }] });
    if (body.type === 'spotClearinghouseState') {
      const have = spot.get(String(body.user));
      return ok({ balances: have === undefined ? [] : [{ coin: 'USDC', token: 0, total: String(have), hold: '0.0' }] });
    }
    throw new Error(`unexpected ${String(body.type)}`);
  };
  return { fetch, sent };
}

async function run(env: Record<string, string | undefined>, net = fakeNet(new Map([[FUNDER_ADDR, 999]]))) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSend({
    env: { APP_ENV: 'test', HL_TESTNET_FUNDER_KEY: FUNDER, HL_SEND_TO: TO, HL_SEND_AMOUNT: '500', ...env },
    fetch: net.fetch,
    clock: () => new Date(NOW),
    sleep: async () => {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, sent: net.sent, text: [...out, ...err].join('\n') };
}

describe('testnet:send', () => {
  it('sends a capped amount of spot USDC, signed by the funder, and sees it land', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.sent).toHaveLength(1);
    const body = r.sent[0] as { action: Record<string, unknown>; nonce: number; signature: { r: string; s: string; v: number } };
    expect(body.action).toMatchObject({
      type: 'spotSend',
      destination: TO,
      token: `USDC:${TOKEN_ID}`,
      amount: '500',
      hyperliquidChain: 'Testnet',
    });
    const { typedData } = spotSendAction(TO, `USDC:${TOKEN_ID}`, '500', BigInt(body.nonce));
    const joined = `${body.signature.r}${body.signature.s.slice(2)}${body.signature.v.toString(16)}`;
    expect(await recoverTypedDataSigner(typedData, joined)).toBe(FUNDER_ADDR);
    expect(r.text).toContain('after: funder 499 spot USDC free, destination 500');
  });

  it('takes the key as MetaMask exports it, 64 hex characters with no 0x, and signs as that account', async () => {
    const r = await run({ HL_TESTNET_FUNDER_KEY: `${FUNDER.slice(2)}\n` });
    expect(r.code).toBe(0);
    expect(r.sent).toHaveLength(1);
    const body = r.sent[0] as { nonce: number; signature: { r: string; s: string; v: number } };
    const { typedData } = spotSendAction(TO, `USDC:${TOKEN_ID}`, '500', BigInt(body.nonce));
    const joined = `${body.signature.r}${body.signature.s.slice(2)}${body.signature.v.toString(16)}`;
    expect(await recoverTypedDataSigner(typedData, joined)).toBe(FUNDER_ADDR);
  });

  it('never prints the key', async () => {
    const r = await run({});
    expect(r.text).not.toContain(FUNDER.slice(2));
  });

  it('refuses above the cap, before anything is sent', async () => {
    const r = await run({ HL_SEND_AMOUNT: '500.01' });
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect(r.text).toContain('above the cap of 500');
  });

  it.each([
    ['no key', { HL_TESTNET_FUNDER_KEY: undefined }, 'HL_TESTNET_FUNDER_KEY is not set'],
    ['a bad key', { HL_TESTNET_FUNDER_KEY: '0x1234' }, 'not a 32-byte hex key'],
    ['a bad address', { HL_SEND_TO: '0xabc' }, 'HL_SEND_TO must be a 0x address'],
    ['the funder itself', { HL_SEND_TO: FUNDER_ADDR }, "the funder's own address"],
    ['zero', { HL_SEND_AMOUNT: '0' }, 'positive USDC amount'],
    ['three decimals', { HL_SEND_AMOUNT: '1.001' }, 'at most 2 decimals'],
    ['mainnet', { HL_API_URL: 'https://api.hyperliquid.xyz' }, 'refused'],
    ['APP_ENV production', { APP_ENV: 'production' }, 'refused'],
  ])('refuses %s with exit 2 and sends nothing', async (_label, env, words) => {
    const r = await run(env);
    expect(r.code).toBe(2);
    expect(r.sent).toHaveLength(0);
    expect(r.text).toContain(words);
    expect(r.text).not.toContain(FUNDER.slice(2));
  });

  it('refuses when the funder holds less than the amount', async () => {
    const r = await run({ HL_SEND_AMOUNT: '100' }, fakeNet(new Map([[FUNDER_ADDR, 50]])));
    expect(r.code).toBe(1);
    expect(r.sent).toHaveLength(0);
    expect(r.text).toContain('less than 100');
  });

  it("fails on the venue's refusal, in its words", async () => {
    const r = await run({}, fakeNet(new Map([[FUNDER_ADDR, 999]]), { status: 'err', response: 'Insufficient balance' }));
    expect(r.code).toBe(1);
    expect(r.text).toContain('refused by the venue: Insufficient balance');
  });
});
