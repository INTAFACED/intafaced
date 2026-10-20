import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chainGuard,
  describeRequest,
  discoverWallets,
  firstAddress,
  parseChainId,
  runSignRequest,
  shortAddress,
  type Eip1193Provider,
} from './eip1193';

const ADDR = '0x1111111111111111111111111111111111111111';
// The sign layer re-reads the chain and the account right before it asks; the fake answers those and hands the rest to `request`.
const fake = (request: Eip1193Provider['request'], chain = '0x14a34'): Eip1193Provider => ({
  request: async (args) => {
    if (args.method === 'eth_chainId') return chain;
    if (args.method === 'eth_accounts') return [ADDR];
    return request(args);
  },
});

afterEach(() => vi.useRealTimers());

describe('wallet discovery (EIP-6963)', () => {
  it('lists a wallet by the name it announces, keeps inline icons only, and ignores malformed announcements', () => {
    const target = new EventTarget();
    const seen: string[][] = [];
    const stop = discoverWallets(target as never, (wallets) =>
      seen.push(wallets.map((wallet) => `${wallet.info.name}|${wallet.info.icon}`)),
    );
    const announce = (detail: unknown) => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    const provider = fake(async () => null);
    announce({ info: { uuid: '1', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,AAAA', rdns: 'test.wallet' }, provider });
    announce({ info: { uuid: '2', name: 'Hostile', icon: 'https://evil.example/x.png', rdns: 'hostile' }, provider });
    announce({ info: { uuid: '3', name: 'No provider', rdns: 'x' } });
    announce({ info: { name: 'No id' }, provider });
    expect(seen.at(-1)).toEqual(['Test Wallet|data:image/svg+xml;base64,AAAA', 'Hostile|']);
    stop();
    announce({ info: { uuid: '9', name: 'Late', icon: '', rdns: 'late' }, provider });
    expect(seen.at(-1)).toHaveLength(2);
  });
});

describe('chain and address parsing', () => {
  it('turns a hex quantity into a chain id and anything else into null, never zero', () => {
    expect(parseChainId('0x14a34')).toBe(84532);
    expect(parseChainId(84532)).toBe(84532);
    for (const bad of ['0x', '0xzz', 'abc', '', 0, -1, null, undefined, 1.5]) expect(parseChainId(bad), String(bad)).toBeNull();
  });
  it('guards the app chain and reports the mismatch', () => {
    expect(chainGuard(84532)).toEqual({ ok: true });
    expect(chainGuard(1)).toEqual({ ok: false, code: 'chain_mismatch', configured: 84532, observed: 1 });
    expect(chainGuard(null)).toMatchObject({ ok: false, observed: null });
  });
  it('accepts only a well-formed first account', () => {
    expect(firstAddress([ADDR])).toBe(ADDR);
    expect(firstAddress([])).toBeNull();
    expect(firstAddress(['0x12'])).toBeNull();
    expect(shortAddress(ADDR)).toBe('0x1111…1111');
  });
});

describe('sign layer returns typed results', () => {
  const typed = { kind: 'typedData' as const, typedData: { types: {}, primaryType: 'Permit', domain: {}, message: {} } };
  it('signed, sent, rejected and failed', async () => {
    expect(
      await runSignRequest(
        fake(async () => '0xabc'),
        ADDR,
        typed,
      ),
    ).toEqual({ status: 'signed', signature: '0xabc' });
    expect(
      await runSignRequest(
        fake(async () => '0xabc'),
        ADDR,
        { kind: 'message', message: 'hi' },
      ),
    ).toEqual({ status: 'signed', signature: '0xabc' });
    const hash = `0x${'a'.repeat(64)}`;
    expect(
      await runSignRequest(
        fake(async () => hash),
        ADDR,
        { kind: 'transaction', to: ADDR },
      ),
    ).toEqual({ status: 'sent', hash });
    expect(
      await runSignRequest(
        fake(async () => Promise.reject({ code: 4001 })),
        ADDR,
        typed,
      ),
    ).toEqual({ status: 'rejected' });
    const failed = await runSignRequest(
      fake(async () => Promise.reject(new Error('boom: secret detail'))),
      ADDR,
      typed,
    );
    expect(failed).toMatchObject({ status: 'failed', reason: 'wallet_error' });
    expect(JSON.stringify(failed)).not.toContain('secret detail');
    // A wallet that answers with something that is not a signature is a failure, never a success.
    expect(
      await runSignRequest(
        fake(async () => 'nope'),
        ADDR,
        typed,
      ),
    ).toMatchObject({ status: 'failed' });
    expect(
      await runSignRequest(
        fake(async () => '0xabc'),
        ADDR,
        { kind: 'transaction', to: ADDR },
      ),
    ).toMatchObject({ status: 'failed' });
  });
  it('gives up with a visible failure when the wallet never answers', async () => {
    vi.useFakeTimers();
    const pending = runSignRequest(
      fake(() => new Promise(() => undefined)),
      ADDR,
      typed,
      1000,
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({ status: 'failed', reason: 'timeout' });
  });
});

describe('the sign layer checks the wallet again right before it asks', () => {
  const typed = (chainId?: number | string) => ({
    kind: 'typedData' as const,
    typedData: { types: {}, primaryType: 'Permit', domain: chainId === undefined ? {} : { chainId }, message: {} },
  });
  it('does not ask a wallet that moved to another chain, for any kind of request', async () => {
    const asked: string[] = [];
    const provider = fake(async ({ method }) => (asked.push(method), '0xabc'), '0x1');
    for (const request of [typed(), { kind: 'message' as const, message: 'x' }, { kind: 'transaction' as const, to: ADDR }])
      expect(await runSignRequest(provider, ADDR, request)).toMatchObject({ status: 'failed', reason: 'chain_mismatch' });
    expect(asked).toEqual([]);
  });
  it('refuses typed data whose own domain names another chain, and accepts the app chain as number or string', async () => {
    const provider = fake(async () => '0xabc');
    expect(await runSignRequest(provider, ADDR, typed(1))).toMatchObject({ reason: 'chain_mismatch' });
    expect(await runSignRequest(provider, ADDR, typed('1'))).toMatchObject({ reason: 'chain_mismatch' });
    expect(await runSignRequest(provider, ADDR, typed(84532))).toMatchObject({ status: 'signed' });
    expect(await runSignRequest(provider, ADDR, typed('84532'))).toMatchObject({ status: 'signed' });
  });
  it('does not sign for an account that is no longer the connected one', async () => {
    const other = {
      request: async ({ method }: { method: string }) =>
        method === 'eth_chainId' ? '0x14a34' : method === 'eth_accounts' ? ['0x2222222222222222222222222222222222222222'] : '0xabc',
    };
    expect(await runSignRequest(other, ADDR, typed())).toMatchObject({ status: 'failed', reason: 'not_connected' });
  });
  it('puts the chain id in the transaction it sends', async () => {
    let sent: unknown;
    const provider = fake(async ({ method, params }) => {
      if (method === 'eth_sendTransaction') sent = params;
      return `0x${'a'.repeat(64)}`;
    });
    await runSignRequest(provider, ADDR, { kind: 'transaction', to: ADDR, data: '0x095ea7b3' });
    expect(sent).toEqual([{ from: ADDR, to: ADDR, chainId: '0x14a34', value: '0x0', data: '0x095ea7b3' }]);
  });
});

describe('the plain-words sheet facts', () => {
  it('shows calldata, a Permit2 token and amount from nested details, and the domain', () => {
    const tx = describeRequest({ kind: 'transaction', to: ADDR, data: '0x095ea7b3ff' });
    expect(tx.find((fact) => fact.label === 'calldata')?.value).toBe('0x095ea7b3ff');
    const permit2 = describeRequest({
      kind: 'typedData',
      typedData: {
        types: {},
        primaryType: 'PermitSingle',
        domain: { name: 'Permit2', chainId: 84532 },
        message: {
          details: { token: '0x3333333333333333333333333333333333333333', amount: '5', expiration: '99' },
          spender: ADDR,
          sigDeadline: '100',
        },
      },
    });
    const byLabel = Object.fromEntries(permit2.map((fact) => [fact.label, fact.value]));
    expect(byLabel).toMatchObject({ token: '0x3333333333333333333333333333333333333333', amount: '5', spender: ADDR });
    expect(byLabel.domain).toContain('Permit2');
  });
  it('shows contract, spender, amount and expiry of a permit', () => {
    const facts = describeRequest({
      kind: 'typedData',
      typedData: {
        types: {},
        primaryType: 'Permit',
        domain: { verifyingContract: '0x2222222222222222222222222222222222222222' },
        message: { spender: ADDR, value: '1000000', deadline: '1900000000' },
      },
    });
    expect(Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))).toEqual({
      action: 'Permit',
      contract: '0x2222222222222222222222222222222222222222',
      spender: ADDR,
      amount: '1000000',
      expiry: '1900000000',
      domain: JSON.stringify({ verifyingContract: '0x2222222222222222222222222222222222222222' }),
    });
  });
});
