import { describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import {
  AttestationRefusedError,
  buildAttest,
  buildRevoke,
  rankAttestationAbi,
  verifyAttestation,
  type AttestationRecord,
  type AttestationReader,
} from './attestation-build.js';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const ISSUER = '0x2222222222222222222222222222222222222222' as Address;
const OTHER = '0x3333333333333333333333333333333333333333' as Address;
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const SCHEMA = `0x${'01'.repeat(32)}` as Hex;
const config = { registry: REGISTRY, chainId: 84532 };
const input = { schemaId: SCHEMA, rank: '12', expiresAt: '4102444800', salt: SALT };

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AttestationRefusedError);
    return (err as AttestationRefusedError).code;
  }
  throw new Error('expected a refusal');
}
async function refusalAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AttestationRefusedError);
    return (err as AttestationRefusedError).code;
  }
  throw new Error('expected a refusal');
}

describe('buildAttest (RC-identity-16)', () => {
  it('rank 12 (TEST) builds a payload with exactly four fields, no identity and no salt', () => {
    const { call, payload } = buildAttest(config, input);
    expect(Object.keys(payload).sort()).toEqual(['commitment', 'expiresAt', 'rank', 'schemaId']);
    expect(payload).toEqual({ schemaId: SCHEMA, rank: '12', expiresAt: '4102444800', commitment: keccak256(SALT) });
    expect(JSON.stringify({ call, payload })).not.toContain(SALT.slice(2));
    expect(call).toMatchObject({ to: REGISTRY, value: '0', chainId: 84532, label: 'Base Sepolia testnet. Not INTACHAIN. audited:false' });
    const decoded = decodeFunctionData({ abi: rankAttestationAbi, data: call.data });
    expect(decoded.functionName).toBe('attest');
    expect(decoded.args).toEqual([keccak256(SALT), 12n, 4102444800n, SCHEMA]);
  });

  it('refuses an extra field (user id, email, name, address) with protocol.attestation_pii_field', () => {
    for (const extra of ['userId', 'email', 'name', 'address']) {
      expect(refusal(() => buildAttest(config, { ...input, [extra]: 'x' }))).toBe('protocol.attestation_pii_field');
    }
  });

  it('refuses when the registry env is unset, blank or 0x0', () => {
    for (const registry of [undefined, '', '0x0000000000000000000000000000000000000000']) {
      expect(refusal(() => buildAttest({ registry, chainId: 84532 }, input))).toBe('protocol.attestation_registry_unset');
      expect(refusal(() => buildRevoke({ registry, chainId: 84532 }, { commitment: keccak256(SALT) }))).toBe(
        'protocol.attestation_registry_unset',
      );
    }
  });

  it('refuses mainnet and any unknown chain with audit.external (fail closed allow-list)', () => {
    for (const chainId of [1, 8453, 10, 42161, 999999]) {
      expect(refusal(() => buildAttest({ registry: REGISTRY, chainId }, input))).toBe('audit.external');
      expect(refusal(() => buildRevoke({ registry: REGISTRY, chainId }, { commitment: keccak256(SALT) }))).toBe('audit.external');
    }
  });

  it('refuses bad rank, expiry, schema or salt with protocol.attestation_input (rank is a string, never a number)', () => {
    for (const bad of [
      { rank: 12 },
      { rank: '-1' },
      { rank: '1000001' },
      { expiresAt: '18446744073709551616' },
      { schemaId: '0x01' },
      { salt: '0x01' },
    ]) {
      expect(refusal(() => buildAttest(config, { ...input, ...bad }))).toBe('protocol.attestation_input');
    }
  });

  it('is deterministic: the same request builds the same call (retry adopts, never a second shape)', () => {
    expect(buildAttest(config, input)).toEqual(buildAttest(config, input));
  });
});

describe('buildRevoke and verify', () => {
  it('buildRevoke encodes revoke(commitment) as an unsigned call', () => {
    const call = buildRevoke(config, { commitment: keccak256(SALT) });
    const decoded = decodeFunctionData({ abi: rankAttestationAbi, data: call.data });
    expect(decoded.functionName).toBe('revoke');
    expect(decoded.args).toEqual([keccak256(SALT)]);
  });

  it('verify reads live, then none after the issuer revokes; another issuer is read separately', async () => {
    const book = new Map<string, AttestationRecord>();
    const key = (c: Hex, i: Address) => `${c}:${i.toLowerCase()}`;
    const read: AttestationReader = async ({ address, commitment, issuer }) => {
      expect(address).toBe(REGISTRY);
      return book.get(key(commitment, issuer)) ?? [0n, 0n, 0n, `0x${'00'.repeat(32)}` as Hex];
    };
    const c = keccak256(SALT);
    book.set(key(c, ISSUER), [12n, 1000n, 4102444800n, SCHEMA]);
    expect(await verifyAttestation(config, { commitment: c, issuer: ISSUER }, read, 2000n)).toEqual({
      status: 'live',
      rank: '12',
      issuedAt: '1000',
      expiresAt: '4102444800',
      schemaId: SCHEMA,
    });
    expect(await verifyAttestation(config, { commitment: c, issuer: OTHER }, read, 2000n)).toEqual({ status: 'none' });
    book.delete(key(c, ISSUER));
    expect(await verifyAttestation(config, { commitment: c, issuer: ISSUER }, read, 2000n)).toEqual({ status: 'none' });
  });

  it('verify reports an attestation past its expiry as expired', async () => {
    const read: AttestationReader = async () => [12n, 1000n, 1500n, SCHEMA];
    expect((await verifyAttestation(config, { commitment: keccak256(SALT), issuer: ISSUER }, read, 2000n)).status).toBe('expired');
  });

  it('verify fails closed: a failed chain read propagates and is never reported as none', async () => {
    const read: AttestationReader = async () => {
      throw new Error('rpc down');
    };
    await expect(verifyAttestation(config, { commitment: keccak256(SALT), issuer: ISSUER }, read)).rejects.toThrow('rpc down');
  });

  it('verify refuses unset registry, mainnet and a bad issuer before reading', async () => {
    let reads = 0;
    const read: AttestationReader = async () => {
      reads += 1;
      return [0n, 0n, 0n, SCHEMA];
    };
    const c = keccak256(SALT);
    expect(await refusalAsync(verifyAttestation({ registry: undefined, chainId: 84532 }, { commitment: c, issuer: ISSUER }, read))).toBe(
      'protocol.attestation_registry_unset',
    );
    expect(await refusalAsync(verifyAttestation({ registry: REGISTRY, chainId: 1 }, { commitment: c, issuer: ISSUER }, read))).toBe(
      'audit.external',
    );
    expect(await refusalAsync(verifyAttestation(config, { commitment: c, issuer: 'nope' }, read))).toBe('protocol.attestation_input');
    expect(reads).toBe(0);
  });
});
