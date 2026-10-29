import { describe, expect, it } from 'vitest';
import { failingPow, grindPow, matMul, powDigest, powHeader, powSpecBlank, powValid, readPowSpec, type PowSpec } from './pow.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const SPEC: PowSpec = { dimension: 8, targetBits: 8, testnet: true };
const published = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MINING_POW_DIMENSION: '8',
  MINING_POW_TARGET_BITS: '8',
  MINING_POW_TESTNET: 'true',
  ...extra,
});

describe('pool proof-of-work check (reference MatMul)', () => {
  it('multiplies two matrices over 32-bit words, wrapping at 2^32', () => {
    // [[1,2],[3,4]] × [[5,6],[7,8]] = [[19,22],[43,50]]
    expect([...matMul(Uint32Array.of(1, 2, 3, 4), Uint32Array.of(5, 6, 7, 8), 2)]).toEqual([19, 22, 43, 50]);
    // (2^32 - 1)² + 0 wraps to 1.
    expect([...matMul(Uint32Array.of(0xffffffff, 0, 0, 0), Uint32Array.of(0xffffffff, 0, 0, 0), 2)]).toEqual([1, 0, 0, 0]);
  });

  it('a ground nonce passes and its digest meets the target; a failing nonce does not', () => {
    const header = powHeader('w1', ALICE, 'Rig-A');
    const good = grindPow(SPEC, header);
    expect(powValid(SPEC, header, good)).toBe(true);
    expect(powDigest(SPEC, header, good)[0]).toBe(0);
    const bad = failingPow(SPEC, header);
    expect(powValid(SPEC, header, bad)).toBe(false);
    expect(powDigest(SPEC, header, bad)[0]).not.toBe(0);
  });

  it('the work is bound to its window, account and rig: the same nonce under another header is checked afresh', () => {
    const header = powHeader('w1', ALICE, 'Rig-A');
    const nonce = grindPow(SPEC, header);
    for (const other of [powHeader('w2', ALICE, 'Rig-A'), powHeader('w1', 'someone-else', 'Rig-A'), powHeader('w1', ALICE, 'Rig-B')]) {
      expect(other.equals(header)).toBe(false);
      expect(powDigest(SPEC, other, nonce).equals(powDigest(SPEC, header, nonce))).toBe(false);
    }
    // Length-prefixed fields: moving a character between fields is a different header.
    expect(powHeader('ab', 'c', 'd').equals(powHeader('a', 'bc', 'd'))).toBe(false);
  });

  it('a harder target refuses work that met an easier one', () => {
    const header = powHeader('w1', ALICE, 'Rig-A');
    const nonce = grindPow(SPEC, header);
    const leading = powDigest(SPEC, header, nonce);
    let bits = 0;
    for (const byte of leading) {
      if (byte === 0) bits += 8;
      else {
        bits += Math.clz32(byte) - 24;
        break;
      }
    }
    expect(powValid({ ...SPEC, targetBits: bits }, header, nonce)).toBe(true);
    expect(powValid({ ...SPEC, targetBits: bits + 1 }, header, nonce)).toBe(false);
  });

  it('a nonce that is not 1 to 16 lower-case hex digits never passes', () => {
    const header = powHeader('w1', ALICE, 'Rig-A');
    const good = grindPow(SPEC, header);
    for (const nonce of ['', 'ABC', 'g1', ` ${good}`, `${good}\n`, '0'.repeat(17), 1, null, undefined]) {
      expect(powValid(SPEC, header, nonce)).toBe(false);
    }
  });

  it('reads a published testnet set; blank, partial or out-of-range refuses mining.pow_spec_unset; mainnet refuses audit.external', () => {
    expect(readPowSpec(published())).toEqual(SPEC);
    expect(powSpecBlank({})).toBe(true);
    expect(powSpecBlank({ MINING_POW_DIMENSION: ' ', MINING_POW_TARGET_BITS: '', MINING_POW_TESTNET: undefined })).toBe(true);
    expect(powSpecBlank(published({ MINING_POW_DIMENSION: '' }))).toBe(false);
    for (const env of [
      {},
      published({ MINING_POW_DIMENSION: '' }),
      published({ MINING_POW_TARGET_BITS: ' ' }),
      published({ MINING_POW_TESTNET: '' }),
      published({ MINING_POW_DIMENSION: '1' }),
      published({ MINING_POW_DIMENSION: '65' }),
      published({ MINING_POW_TARGET_BITS: '0' }),
      published({ MINING_POW_TARGET_BITS: '33' }),
      published({ MINING_POW_DIMENSION: '8.5' }),
      published({ MINING_POW_TESTNET: 'yes' }),
    ]) {
      expect(() => readPowSpec(env), JSON.stringify(env)).toThrow(expect.objectContaining({ code: 'mining.pow_spec_unset' }));
    }
    expect(() => readPowSpec(published({ MINING_POW_TESTNET: 'false' }))).toThrow(expect.objectContaining({ code: 'audit.external' }));
  });
});
