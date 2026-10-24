import { describe, expect, it } from 'vitest';
import { describeRequest, refuseReason } from './eip1193';
import { PermitRefused, buildPermit, checkPermitInput, decodeDecimals, decodeDomain, decodeNonce, noncesCall, toBaseUnits } from './permit';

const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const NOW = new Date('2026-10-24T08:00:00.000Z');

const pad = (hex: string) => hex.padStart(64, '0');
const num = (n: number | bigint) => pad(BigInt(n).toString(16));
function str(text: string): string {
  const bytes = Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
  return num(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
}
/** The EIP-5267 answer, ABI-encoded by hand: fields, name, version, chainId, verifyingContract, salt, extensions. */
function domainAnswer({ fields = 0x0f, name = 'TEST Token', version = '1', chainId = 84532, contract = TOKEN } = {}): string {
  const nameEnc = str(name);
  const versionEnc = str(version);
  const head = 7 * 32;
  const nameAt = head;
  const versionAt = nameAt + nameEnc.length / 2;
  const extAt = versionAt + versionEnc.length / 2;
  return (
    '0x' +
    fields.toString(16).padStart(2, '0').padEnd(64, '0') +
    num(nameAt) +
    num(versionAt) +
    num(chainId) +
    pad(contract.slice(2)) +
    pad('') +
    num(extAt) +
    nameEnc +
    versionEnc +
    num(0)
  );
}
const input = { owner: OWNER, token: TOKEN, spender: SPENDER, amount: '25.5', expiresInMinutes: '30' };

describe('EIP-2612 permit built from the token itself', () => {
  it('decodes the token domain, decimals and nonce answers', () => {
    expect(decodeDomain(domainAnswer())).toEqual({ name: 'TEST Token', version: '1', chainId: 84532, verifyingContract: TOKEN });
    expect(decodeDecimals(`0x${num(6)}`)).toBe(6);
    expect(decodeNonce(`0x${num(7)}`)).toBe(7n);
    expect(noncesCall(OWNER)).toBe(`0x7ecebe00${pad(OWNER.slice(2))}`);
  });

  it('refuses a domain it would have to guess, and a token with more than 18 decimals', () => {
    expect(() => decodeDomain('0x')).toThrow(PermitRefused);
    expect(() => decodeDomain(domainAnswer({ fields: 0x1f }))).toThrow(expect.objectContaining({ code: 'domain_missing' }));
    expect(() => decodeDecimals(`0x${num(19)}`)).toThrow(expect.objectContaining({ code: 'decimals_invalid' }));
    expect(() => decodeNonce('0x12')).toThrow(expect.objectContaining({ code: 'nonce_invalid' }));
    expect(() => decodeDecimals('0x')).toThrow(expect.objectContaining({ code: 'decimals_invalid' }));
    // A verifying-contract word with dirty high bytes is not an address.
    const dirty = domainAnswer().replace(pad(TOKEN.slice(2)), `ff${pad(TOKEN.slice(2)).slice(2)}`);
    expect(() => decodeDomain(dirty)).toThrow(expect.objectContaining({ code: 'domain_missing' }));
    // A name that is not UTF-8 is refused, not thrown as a decoder error.
    const badName = domainAnswer({ name: 'AB' }).replace('4142', 'ff42');
    expect(() => decodeDomain(badName)).toThrow(expect.objectContaining({ code: 'domain_missing' }));
  });

  it('scales whole tokens to base units and never rounds', () => {
    expect(toBaseUnits('25.5', 6)).toBe(25_500_000n);
    expect(toBaseUnits('1', 18)).toBe(10n ** 18n);
    expect(() => toBaseUnits('0.0000001', 6)).toThrow(expect.objectContaining({ code: 'amount_precision' }));
    expect(() => toBaseUnits('0', 6)).toThrow(expect.objectContaining({ code: 'amount_invalid' }));
    expect(() => toBaseUnits('-1', 6)).toThrow(expect.objectContaining({ code: 'amount_invalid' }));
    expect(() => toBaseUnits('0.0000000000000000001', 6)).toThrow(expect.objectContaining({ code: 'amount_precision' }));
    expect(toBaseUnits('1.50', 1)).toBe(15n);
    // Not capped by the ledger's 18-decimal column: a 0-decimal token can permit 10^21 units.
    expect(toBaseUnits('1000000000000000000000', 0)).toBe(10n ** 21n);
    expect(() => toBaseUnits((2n ** 256n).toString(), 0)).toThrow(expect.objectContaining({ code: 'amount_invalid' }));
  });

  it('checks the form before anything is read', () => {
    expect(checkPermitInput(input)).toBeNull();
    expect(checkPermitInput({ ...input, token: '0x12' })).toBe('token_invalid');
    expect(checkPermitInput({ ...input, spender: '' })).toBe('spender_invalid');
    expect(checkPermitInput({ ...input, amount: '1e3' })).toBe('amount_invalid');
    expect(checkPermitInput({ ...input, amount: '0.00' })).toBe('amount_invalid');
    expect(checkPermitInput({ ...input, expiresInMinutes: '0' })).toBe('expiry_invalid');
  });

  it('builds the exact permit, and the sheet shows token, amount, spender and expiry from it', () => {
    const doc = buildPermit(input, { domain: decodeDomain(domainAnswer()), decimals: 6, nonce: 7n }, 84532, NOW);
    expect(doc.domain).toEqual({ name: 'TEST Token', version: '1', chainId: 84532, verifyingContract: TOKEN });
    const deadline = String(Math.floor(NOW.getTime() / 1000) + 30 * 60);
    expect(doc.message).toEqual({ owner: OWNER, spender: SPENDER, value: '25500000', nonce: '7', deadline });
    expect(refuseReason({ kind: 'typedData', typedData: doc })).toBeNull();
    const facts = describeRequest({ kind: 'typedData', typedData: doc });
    expect(facts).toEqual(
      expect.arrayContaining([
        { label: 'token', value: TOKEN },
        { label: 'spender', value: SPENDER },
        { label: 'amount', value: '25500000' },
        { label: 'expiry', value: deadline },
      ]),
    );
    expect(facts.filter((fact) => fact.label === 'token')).toHaveLength(1);
  });

  it('refuses a domain for another chain or another contract', () => {
    const other = { decimals: 6, nonce: 0n };
    expect(() => buildPermit(input, { ...other, domain: decodeDomain(domainAnswer({ chainId: 1 })) }, 84532, NOW)).toThrow(
      expect.objectContaining({ code: 'domain_mismatch' }),
    );
    expect(() => buildPermit(input, { ...other, domain: decodeDomain(domainAnswer({ contract: SPENDER })) }, 84532, NOW)).toThrow(
      expect.objectContaining({ code: 'domain_mismatch' }),
    );
  });
});
