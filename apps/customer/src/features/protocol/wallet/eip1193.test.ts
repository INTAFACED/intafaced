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
const fake = (request: Eip1193Provider['request']): Eip1193Provider => ({ request });

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

describe('the plain-words sheet facts', () => {
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
    });
  });
});
