/** RC-identity-16 — the attestation procedures on the svc-protocol router (stub deps, no chain). */
import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const REGISTRY = '0x1111111111111111111111111111111111111111';
const ISSUER = '0x2222222222222222222222222222222222222222';
const SALT = `0x${'ab'.repeat(32)}` as Hex;
const SCHEMA = `0x${'01'.repeat(32)}` as Hex;

function deps(chainId: number, rankAttestation?: ProtocolRouterDeps['rankAttestation']): ProtocolRouterDeps {
  return {
    chain: { config: { chainId, factory: ZERO, implementation: ZERO }, isDeployed: async () => false },
    registry: { accountsOf: async () => [] },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO as `0x${string}`,
    swapSlippageBps: () => null,
    rankAttestation,
  } as unknown as ProtocolRouterDeps;
}

const edgeContext = createEdgeContext({ secret: 'a-protocol-attestation-test-edge-secret', serviceName: 'svc-protocol' });

/** Public jurisdiction procedures: an anonymous caller from an allowed region, as index.ts builds it. */
function caller(d: ProtocolRouterDeps) {
  return createProtocolRouter(d).createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-attest' }));
}

const input = { schemaId: SCHEMA, rank: '12', expiresAt: '4102444800', salt: SALT };

describe('attestation procedures (RC-identity-16)', () => {
  it('buildAttest returns an unsigned call and the four-field payload on the testnet', async () => {
    const out = await caller(deps(84532, { registry: () => REGISTRY, read: async () => [0n, 0n, 0n, SCHEMA] })).attestationBuildAttest(
      input,
    );
    expect(Object.keys(out.payload).sort()).toEqual(['commitment', 'expiresAt', 'rank', 'schemaId']);
    expect(out.call.to).toBe(REGISTRY);
  });

  it('refuses an extra (PII) field as BAD_REQUEST protocol.attestation_pii_field', async () => {
    await expect(
      caller(deps(84532, { registry: () => REGISTRY, read: async () => [0n, 0n, 0n, SCHEMA] })).attestationBuildAttest({
        ...input,
        email: 'a@b.c',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('protocol.attestation_pii_field') });
  });

  it('refuses with no registry wired, and on mainnet, as PRECONDITION_FAILED', async () => {
    await expect(caller(deps(84532)).attestationBuildAttest(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.attestation_registry_unset'),
    });
    await expect(caller(deps(84532)).attestationVerify({ commitment: keccak256(SALT), issuer: ISSUER })).rejects.toMatchObject({
      message: expect.stringContaining('protocol.attestation_registry_unset'),
    });
    await expect(
      caller(deps(8453, { registry: () => REGISTRY, read: async () => [0n, 0n, 0n, SCHEMA] })).attestationBuildRevoke({
        commitment: keccak256(SALT),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('audit.external') });
  });

  it('verify fails closed when the chain read throws: an error, never status none', async () => {
    const d = deps(84532, {
      registry: () => REGISTRY,
      read: async () => {
        throw new Error('rpc down');
      },
    });
    await expect(caller(d).attestationVerify({ commitment: keccak256(SALT), issuer: ISSUER })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('verify returns live for an issued record', async () => {
    const d = deps(84532, { registry: () => REGISTRY, read: async () => [12n, 1000n, 4102444800n, SCHEMA] });
    await expect(caller(d).attestationVerify({ commitment: keccak256(SALT), issuer: ISSUER })).resolves.toMatchObject({
      status: 'live',
      rank: '12',
    });
  });
});
