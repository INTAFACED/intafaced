import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { navigatorAskIsTrade, navigatorAskMovesMoneyOut } from '@intafaced/contracts/agents-onchain';
import { parseTradeAsk, toUnits } from './onchain-trade.js';
import { bindKey, capWei, FORBIDDEN_SELECTORS, navigatorSigner, NavigatorOnchainError, preparedGrant } from './onchain.js';

const SIGNER = '0x00000000000000000000000000000000005e0019';
const ACCOUNT = '0x00000000000000000000000000000000000a0019';
const ROUTER = '0x00000000000000000000000000000000000b0019';
const SWAP = '0x' + 'ab'.repeat(4);
const HASH = '0x' + '11'.repeat(32);
const grant = {
  chainId: 84532,
  account: ACCOUNT,
  specHash: HASH,
  spendLimitWei: '1000',
  validUntil: 2_000_000_000,
  targets: [ROUTER],
  selectors: [SWAP],
};

function refusal(fn: () => unknown): { code: string; field?: string } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NavigatorOnchainError);
    const e = err as NavigatorOnchainError;
    return { code: e.code, ...(e.field ? { field: e.field } : {}) };
  }
  throw new Error('expected a refusal');
}

describe('the Navigator signer', () => {
  it('names the configured address on the test network, labelled testnet', () => {
    expect(navigatorSigner(84532, SIGNER)).toEqual({ signer: SIGNER, chainId: 84532, network: 'testnet' });
  });
  it('refuses mainnet with audit.external, even when a signer is configured', () => {
    expect(refusal(() => navigatorSigner(8453, SIGNER)).code).toBe('audit.external');
  });
  it('refuses rail.crypto when no signer is configured', () => {
    expect(refusal(() => navigatorSigner(84532, null)).code).toBe('rail.crypto');
    expect(refusal(() => navigatorSigner(84532, '')).code).toBe('rail.crypto');
  });
  it('refuses any other chain as unsupported', () => {
    expect(refusal(() => navigatorSigner(1, SIGNER)).code).toBe('agents.onchain_chain_unsupported');
  });
});

describe('a prepared grant', () => {
  it('refuses a blank, malformed, fractional or negative cap naming the cap', () => {
    for (const cap of [undefined, null, '', '  ', '1.5', '-1', 'one', '1e18'])
      expect(refusal(() => preparedGrant({ ...grant, spendLimitWei: cap }))).toEqual({
        code: 'agents.session_key_cap_unset',
        field: 'spendLimitWei',
      });
  });
  it('refuses a cap past uint128', () => {
    expect(refusal(() => capWei((1n << 128n).toString())).code).toBe('agents.session_key_cap_unset');
    expect(capWei(((1n << 128n) - 1n).toString())).toBe(((1n << 128n) - 1n).toString());
  });
  it('keeps the cap exact as a decimal string of wei, never a number', () => {
    expect(capWei('1000000000000000000')).toBe('1000000000000000000');
    expect(capWei('0')).toBe('0');
  });
  it('refuses a missing expiry by name', () => {
    expect(refusal(() => preparedGrant({ ...grant, validUntil: null }))).toEqual({
      code: 'agents.session_key_expiry_unset',
      field: 'validUntil',
    });
    expect(refusal(() => preparedGrant({ ...grant, validUntil: undefined })).code).toBe('agents.session_key_expiry_unset');
  });
  it('refuses an approve, permit or transfer selector, in any case', () => {
    for (const selector of ['0x095ea7b3', '0x095EA7B3', '0xd505accf', '0xa9059cbb', '0x23b872dd', '0xa22cb465'])
      expect(refusal(() => preparedGrant({ ...grant, selectors: [SWAP, selector] })).code).toBe('agents.session_key_selector_forbidden');
    expect(FORBIDDEN_SELECTORS.has('0x095ea7b3')).toBe(true);
  });
  it('passes a scoped grant through with its cap and expiry', () => {
    expect(preparedGrant(grant)).toEqual({ spendLimitWei: '1000', validUntil: 2_000_000_000 });
  });
  it('keys a binding by chain, account and key, lowercased', () => {
    expect(bindKey(84532, '0xABCDEF0000000000000000000000000000000001', '0x00000000000000000000000000000000005E0019')).toBe(
      'agents:onchain:navigator:84532:0xabcdef0000000000000000000000000000000001:0x00000000000000000000000000000000005e0019',
    );
  });
});

describe("the trade rule: a trade ask is the Navigator's to place inside the signed cap", () => {
  it('reads an ask that names a trade as a trade, as a whole word in any case', () => {
    for (const ask of [
      'TEST: swap 0.1 TEST Wrapped ETH for TEST Token B',
      'Buy some',
      'SELL it all',
      'trade now',
      'place an order',
      'Can you buy 1 TEST Token A?',
      'TEST: please could you sell it all?',
    ])
      expect(navigatorAskIsTrade(ask)).toBe(true);
  });
  it('leaves any other ask to the ordinary run', () => {
    for (const ask of [
      'what moved today?',
      'swapping words is not swaps',
      'buyer',
      'disorder',
      'tradeoffs',
      'reorder the list',
      'Where do I place a limit order?',
      'TEST: what is a market order?',
      'TEST: and a stop order?',
    ])
      expect(navigatorAskIsTrade(ask)).toBe(false);
  });
  it('reads a withdrawal, or a send, transfer or payment to an address, as moving money out', () => {
    for (const ask of [
      'withdraw it',
      'TEST: send 1 TESTB to 0x' + 'ab'.repeat(20),
      'Pay 0x' + 'cd'.repeat(20) + ' now',
      'can you withdraw?',
    ])
      expect(navigatorAskMovesMoneyOut(ask)).toBe(true);
    for (const ask of ['send me a summary', 'how do withdrawals work?', 'what does it pay?', 'transfer pricing explained'])
      expect(navigatorAskMovesMoneyOut(ask)).toBe(false);
  });
  it('parses "swap <amount> <token> for <token>" and nothing looser', () => {
    expect(parseTradeAsk('TEST: swap 0.1 TEST Wrapped ETH for TEST Token B')).toEqual({
      amount: '0.1',
      tokenIn: 'TEST Wrapped ETH',
      tokenOut: 'TEST Token B',
    });
    expect(parseTradeAsk('sell 2 TESTWETH into TESTB on-chain.')).toEqual({ amount: '2', tokenIn: 'TESTWETH', tokenOut: 'TESTB' });
    for (const ask of ['buy some', 'swap all TESTWETH for TESTB', 'swap -1 TESTWETH for TESTB', 'swap 1e3 TESTWETH for TESTB'])
      expect(parseTradeAsk(ask)).toBeNull();
  });
  it('keeps amounts exact in the smallest unit, never a number, and refuses more decimals than the token has', () => {
    expect(toUnits('0.1', 18)).toBe(10n ** 17n);
    expect(toUnits('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
    expect(toUnits('1.0000001', 6)).toBeNull();
    expect(toUnits('1.', 18)).toBeNull();
  });
});

describe('the routes hold to the floor', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = ['onchain.ts', 'onchain-routes.ts', 'onchain-trade.ts'].map((f) => readFileSync(join(here, f), 'utf8')).join('\n');
  it('import no ledger recipe and no svc-protocol code', () => {
    expect(source).not.toMatch(/ledger-client|svc-protocol\/|from '\.\.\/\.\.\/\.\.\/svc-protocol/);
    expect(source).not.toMatch(/\.run\.complete|gateway\.|feeCharge/);
  });
  it("hold no key and sign nothing: the Navigator's signer is outside this service", () => {
    expect(source).not.toMatch(/privateKeyToAccount|mnemonicToAccount|signTransaction|createWalletClient|PRIVATE_KEY/);
  });
});
