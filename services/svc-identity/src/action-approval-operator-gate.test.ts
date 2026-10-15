/**
 * Unit card — four-eyes over operator action types needs an operator (issue #4724, identity half)
 *
 * 1. Promise: only an operator (founder, or an `admin:*` / `market:ops` / `support:ops` scope, never an
 *    API key) can propose, approve or reject an operator action type such as `edge.kill`; money, venue and
 *    treasury types (`matching.open`, ...) are founder-only (see action-approval-founder.test.ts).
 * 2. Break: the router had no role check, so any two self-registered users with a TOTP could propose and
 *    approve `matching.open` between themselves.
 * 3. Done bar: two ordinary MFA users are refused on propose and on approve (matching.open and one other
 *    type, including an unknown type); two operators still complete four-eyes on an operator type; self types
 *    are unaffected; the registry classifies same-person types as `self`, money/venue/treasury types as
 *    `founder` and everything else as `operator`.
 * 4. Class M
 * 5. Paths: services/svc-identity/src/action-approval-router.ts, auth/action-approval-audience.ts
 * 6. RED before: ordinary users approved each other
 */
import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { SAME_PERSON_ACTION_TYPES, type Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from './action-approval-router.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore } from './auth/action-approval-store.js';
import { audienceOf, isOperatorPrincipal, staticFounderDirectory } from './auth/action-approval-audience.js';

const authConfig = {
  secret: 'an-identity-operator-gate-test-secret-long-enough-x',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const U1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const O1 = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const O2 = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = '55555555-5555-4555-8555-555555555555';
const HASH = `sha256:${'d'.repeat(64)}`;

async function ctxFor(userId: string, scopes: string[], extra: { apiKeyId?: string } = {}): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: scopes as never, tier: 'none', mfa: true, ...extra },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-og' };
}

const ordinary = (id: string) => ctxFor(id, ['identity:write', 'bank:write']);
const operator = (id: string) => ctxFor(id, ['identity:write', 'admin:write']);

function build(privilegedUserIds: string[] = []) {
  const service = new ActionApprovalService(new MemoryActionApprovalStore(), {
    ttlSeconds: 60,
    founders: staticFounderDirectory(privilegedUserIds),
  });
  return { r: createActionApprovalRouter(service, { privilegedUserIds }), service };
}

const matchingOpen = {
  actionType: 'matching.open',
  targetService: 'svc-matching',
  targetId: 'matching.open',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  policyVersion: 'v1',
};
const edgeKill = { ...matchingOpen, actionType: 'edge.kill', targetService: 'svc-edge', targetId: 'kill:trade' };
const unknownType = { ...matchingOpen, actionType: 'some.unregistered.thing', targetId: 'some.unregistered.thing' };

describe('operator action types need an operator principal', () => {
  it('refuses two ordinary TOTP users on propose for matching.open, another operator type and an unknown type', async () => {
    const { r } = build();
    const u1 = r.createCaller(await ordinary(U1));
    for (const input of [matchingOpen, edgeKill, unknownType]) {
      await expect(u1.actionApproval.propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses an ordinary user approving or rejecting an operator approval a real operator proposed', async () => {
    const { r } = build();
    const o1 = r.createCaller(await operator(O1));
    const u2 = r.createCaller(await ordinary(U2));
    const pending = await o1.actionApproval.propose(edgeKill);
    const bound = { approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash };
    await expect(u2.actionApproval.approve(bound)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(u2.actionApproval.reject({ approvalId: pending.approvalId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // still pending, then a real second operator completes four-eyes
    const o2 = r.createCaller(await operator(O2));
    await expect(o2.actionApproval.approve(bound)).resolves.toMatchObject({
      status: 'APPROVED',
      approverId: O2,
    });
  });

  it('two operators still complete four-eyes, and the requester still cannot approve their own', async () => {
    const { r } = build();
    const o1 = r.createCaller(await operator(O1));
    const o2 = r.createCaller(await operator(O2));
    const pending = await o1.actionApproval.propose(edgeKill);
    const bound = { approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash };
    await expect(o1.actionApproval.approve(bound)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(o2.actionApproval.approve(bound)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('a founder (privileged user id) and the module operator scopes count as operators', async () => {
    const { r } = build([U1]);
    const founder = r.createCaller(await ordinary(U1));
    await expect(founder.actionApproval.propose(matchingOpen)).resolves.toMatchObject({ status: 'PENDING' });
    const vendorOps = r.createCaller(await ctxFor(U2, ['identity:write', 'market:ops']));
    await expect(
      vendorOps.actionApproval.propose({
        ...matchingOpen,
        actionType: 'market.vendor.vet',
        targetService: 'svc-market',
        targetId: 'market.vendor.vet',
      }),
    ).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('an API key is never an operator, even carrying an admin scope', async () => {
    const { r } = build();
    const key = r.createCaller(await ctxFor(O1, ['identity:write', 'admin:write'], { apiKeyId: 'key-1' }));
    await expect(key.actionApproval.propose(matchingOpen)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('self (same-person) types are unaffected: an ordinary user creates one, and four-eyes refuses them', async () => {
    const verify = vi.fn(async () => undefined);
    const service = new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: 60 });
    const r = createActionApprovalRouter(service, { verifyFactor: verify });
    const u1 = r.createCaller(await ordinary(U1));
    await expect(
      u1.actionApproval.createSamePerson({ actionType: 'bank.step_up.transfers.toUser', payloadHash: HASH, totpCode: '123456' }),
    ).resolves.toMatchObject({ kind: 'same_person', status: 'APPROVED' });
    await expect(
      u1.actionApproval.propose({ ...matchingOpen, actionType: 'bank.step_up.transfers.toUser', targetService: 'svc-bank' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' }); // a four-eyes request is judged by type and target, never skipped as "self"
  });

  it('an approve for an unknown approval id is not_found, not a role disclosure', async () => {
    const { r } = build();
    const u1 = r.createCaller(await ordinary(U1));
    await expect(u1.actionApproval.approve({ approvalId: 'nope', expectedPayloadHash: 'sha256:abc' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('action type audience registry', () => {
  it('lists the same-person types as self, money/venue/treasury types as founder; every other type, known or not, is operator', () => {
    for (const t of SAME_PERSON_ACTION_TYPES) expect(audienceOf(t)).toBe('self');
    for (const t of ['matching.open', 'ledger.unfreeze', 'bank.fund_pool', 'token.revenue.distribute']) {
      expect(audienceOf(t)).toBe('founder');
    }
    for (const t of ['edge.kill', 'market.vendor.vet', 'academy.ambassador.appoint', 'halt:BTC-USDT', 'other', '']) {
      expect(audienceOf(t)).toBe('operator');
    }
  });

  it('isOperatorPrincipal: admin scopes and founders yes; plain sessions and delegated principals no', () => {
    const base = { userId: U1, mfa: true, scopes: ['bank:write'] as readonly string[] };
    expect(isOperatorPrincipal(base)).toBe(false);
    expect(isOperatorPrincipal({ ...base, scopes: ['admin:treasury'] })).toBe(true);
    expect(isOperatorPrincipal({ ...base, scopes: ['admin:compliance'] })).toBe(true);
    expect(isOperatorPrincipal(base, [U1.toUpperCase()])).toBe(true);
    expect(isOperatorPrincipal({ ...base, scopes: ['admin:write'], kid: 'k' })).toBe(false);
    expect(isOperatorPrincipal({ ...base, scopes: ['admin:write'], sub_account: 's' })).toBe(false);
  });
});
