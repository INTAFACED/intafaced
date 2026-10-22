import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { badgeClaimKey, noBadgeSigner } from './founding-badge.js';
import { memBadgeStore } from './founding-badge.test-store.js';

/** RC-more-catalogue-04 review: the stuck-mint clear is mounted, admin-scoped, four-eyes, audited, with typed refusals. */
const ACCOUNT = 'bad9e000-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'bad9e000-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'a-protocol-badge-operator-edge-secret-x';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
const TX = `0x${'aa'.repeat(32)}` as Hex;

function signedAs(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-badge-operator',
  });
}

function build(opts: { approvals?: boolean; age?: number } = {}) {
  const store = memBadgeStore([ACCOUNT]);
  const key = badgeClaimKey(ACCOUNT);
  store.rows.set(key, {
    key,
    accountId: ACCOUNT,
    chainId: 31337,
    to: `0x${'00'.repeat(19)}d1`,
    txHash: null,
    mintingSince: new Date('2026-10-22T03:00:00Z'),
  });
  const deps = {
    chain: { config: { chainId: 31337 }, isDeployed: async () => false },
    registry: { accountsOf: async () => [] },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    badge: {
      store,
      minter: noBadgeSigner,
      window: () => null,
      mainnet: () => false,
      now: () => new Date('2026-10-22T04:00:00Z'),
      approvals:
        opts.approvals === false
          ? null
          : { consume: async () => ({ status: 'CONSUMED', requesterId: 'ops:first', approverId: 'ops:second' }) },
      stuckMintAgeSeconds: () => opts.age,
    },
  } as unknown as ProtocolRouterDeps;
  return { router: createProtocolRouter(deps), store };
}

const body = (reason = 'rpc timeout during mint') => ({
  accountId: ACCOUNT,
  evidence: { kind: 'minted' as const, txHash: TX },
  reason,
  approvalId: 'appr-1',
  operationId: 'op-1',
});

describe('svc-protocol mount — badge.resolveStuckMint (operator clear)', () => {
  it('a customer (protocol:read only) is refused and nothing is cleared', async () => {
    const { router, store } = build({ age: 600 });
    await expect(router.createCaller(signedAs(ACCOUNT, ['protocol:read'])).badge.resolveStuckMint(body())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(store.audits).toHaveLength(0);
    expect(store.rows.get(badgeClaimKey(ACCOUNT))!.txHash).toBeNull();
  });

  it('an admin:write operator with a four-eyes approval clears it and the audit names actor, proposer and approver', async () => {
    const { router, store } = build({ age: 600 });
    const out = await router.createCaller(signedAs(OPERATOR, ['admin:write'])).badge.resolveStuckMint(body());
    expect(out).toEqual({ cleared: true, key: badgeClaimKey(ACCOUNT), txHash: TX });
    expect(store.audits).toEqual([
      expect.objectContaining({ actorId: OPERATOR, requesterId: 'ops:first', approverId: 'ops:second', approvalId: 'appr-1' }),
    ]);
  });

  it('typed refusals map to client errors with the code intact', async () => {
    const op = signedAs(OPERATOR, ['admin:write']);
    await expect(build({ age: undefined }).router.createCaller(op).badge.resolveStuckMint(body())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/^badge\.stuck_age_unset/),
    });
    await expect(build({ age: 7200 }).router.createCaller(op).badge.resolveStuckMint(body())).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/^badge\.stuck_not_stale/),
    });
    await expect(build({ age: 600, approvals: false }).router.createCaller(op).badge.resolveStuckMint(body())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^badge\.stuck_approval_unwired/),
    });
    await expect(build({ age: 600 }).router.createCaller(op).badge.resolveStuckMint(body(' '))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/^badge\.stuck_evidence_required/),
    });
  });
});
