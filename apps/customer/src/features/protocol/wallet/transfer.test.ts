import { describe, expect, it } from 'vitest';
import { isContractCode, isTokenDecimals, lastFour, readDestination, readScan, receivePayload, sameAddress, toBaseUnits } from './transfer';

const FRIEND = '0x52908400098527886E0F7030069857D2E4169EE7';
const TOKEN = '0x00000000000000000000000000000000000a11ce';

describe('readDestination', () => {
  it('tells an address, a name and neither apart', () => {
    expect(readDestination('  ')).toEqual({ kind: 'empty' });
    expect(readDestination(FRIEND)).toEqual({ kind: 'address', address: FRIEND });
    expect(readDestination('Nobody-Here.test')).toEqual({ kind: 'name', name: 'nobody-here.test' });
    expect(readDestination('shop.base.eth')).toEqual({ kind: 'name', name: 'shop.base.eth' });
    expect(readDestination('0x1234')).toEqual({ kind: 'invalid' });
    expect(readDestination('no spaces.eth')).toEqual({ kind: 'invalid' });
    expect(readDestination('plainword')).toEqual({ kind: 'invalid' });
  });
  it('compares addresses and their last four without case', () => {
    expect(sameAddress(FRIEND, FRIEND.toLowerCase())).toBe(true);
    expect(sameAddress(FRIEND, null)).toBe(false);
    expect(lastFour(FRIEND)).toBe('9ee7');
  });
});

describe('toBaseUnits', () => {
  it('scales a decimal without a float', () => {
    expect(toBaseUnits('1', 18)).toBe(10n ** 18n);
    expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(toBaseUnits('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
    expect(toBaseUnits('2.5', 6)).toBe(2_500_000n);
  });
  it('refuses zero, too many places, signs and junk', () => {
    for (const bad of ['0', '0.0', '1.0000001', '-1', '1e3', '', '.5', '1,000'])
      expect(toBaseUnits(bad, bad === '1.0000001' ? 6 : 18)).toBeNull();
  });
});

describe('contract and token checks', () => {
  it('reads eth_getCode and decimals() answers', () => {
    expect(isContractCode('0x')).toBe(false);
    expect(isContractCode('0x6080')).toBe(true);
    expect(isTokenDecimals(`0x${'0'.repeat(62)}12`)).toBe(true);
    expect(isTokenDecimals('0x')).toBe(false);
    expect(isTokenDecimals(null)).toBe(false);
    expect(isTokenDecimals(`0x${'f'.repeat(64)}`)).toBe(false);
  });
});

describe('readScan', () => {
  it('reads payment addresses on this network', () => {
    expect(readScan(`ethereum:${FRIEND}`)).toEqual({ kind: 'address', address: FRIEND, chainId: null });
    expect(readScan(`ethereum:${TOKEN}@84532`)).toEqual({ kind: 'address', address: TOKEN, chainId: 84532 });
    expect(readScan(FRIEND)).toEqual({ kind: 'address', address: FRIEND, chainId: null });
    expect(readScan(`ethereum:pay-${FRIEND}@84532`)).toEqual({ kind: 'address', address: FRIEND, chainId: 84532 });
  });
  it('keeps the token a transfer code asks for', () => {
    expect(readScan(`ethereum:${TOKEN}@84532/transfer?address=${FRIEND}&uint256=1`)).toEqual({
      kind: 'address',
      address: FRIEND,
      chainId: 84532,
      token: TOKEN,
    });
    expect(readScan(`ethereum:${TOKEN}/approve?address=${FRIEND}`)).toEqual({ kind: 'unknown' });
  });
  it('names another network instead of using it', () => {
    expect(readScan(`ethereum:${FRIEND}@1`)).toEqual({ kind: 'otherNetwork', chainId: 1 });
  });
  it('reads a connection code and nothing else', () => {
    const uri = 'wc:00000000-0000-4000-8000-000000000000@2?relay-protocol=irn&symKey=00';
    expect(readScan(uri)).toEqual({ kind: 'connect', uri });
    for (const text of ['hello', 'ethereum:', 'bitcoin:bc1qxyz', `ethereum:${FRIEND}@x`])
      expect(readScan(text)).toEqual({ kind: 'unknown' });
  });
  it('draws the receive code on the app network', () => {
    expect(receivePayload(FRIEND)).toBe(`ethereum:${FRIEND}@84532`);
  });
});
