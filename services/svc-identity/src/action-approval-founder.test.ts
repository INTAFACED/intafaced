/**
 * Unit card — founder-only audience and payload-bound approval for four-eyes (W17)
 *
 * 1. Promise: money, venue and treasury approvals (pay.*, matching.*, ledger.*, bank.*, token.*, a few identity
 *    fee/limit/payout types) are proposed, approved, rejected and consumed only by live founders; an approver
 *    approves the exact payload they reviewed.
 * 2. Break: "operator" meant founder OR any `admin:*` OR market:ops OR support:ops for every type; approve took
 *    an id only, so an approver could approve a payload other than the one they reviewed; and a pre-existing
 *    APPROVED row was spendable whoever had approved it.
 * 3. Done bar: an `admin:*` and a `support:ops` operator cannot propose, approve, reject or consume a founder type;
 *    a founder pair can; the proposer cannot self-approve; a wrong payload hash is refused and the right one is
 *    accepted; a row approved by a non-founder before this check existed is refused at consume; an unwired founder
 *    directory refuses closed; operator-only types (matching.halt) still run on plain operators.
 * 4. Class M
 * 5. Paths: services/svc-identity/src/action-approval-router.ts, auth/action-approval-audience.ts,
 *    auth/action-approval-service.ts
 * 6. RED before: no founder audience, approve took an id only, consume never looked at who approved
 */
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { actionApprovalSchema, PROTECTIVE_OPERATOR_APPROVALS, SAME_PERSON_ACTION_TYPES, type Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from './action-approval-router.js';
import { ActionApprovalError, ActionApprovalService, payloadHashesEqual } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore, newApprovalIds, type StoredApproval } from './auth/action-approval-store.js';
import {
  audienceOf,
  audienceOfApproval,
  staticFounderDirectory,
  type ActionAudience,
  type FounderDirectory,
} from './auth/action-approval-audience.js';

const authConfig = {
  secret: 'an-identity-founder-audience-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const F1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN2 = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const SUPPORT = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION = '66666666-6666-4666-8666-666666666666';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

async function ctxFor(userId: string, scopes: string[], extra: { apiKeyId?: string; mfa?: boolean } = {}): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId,
      sessionId: SESSION,
      scopes: scopes as never,
      tier: 'none',
      mfa: extra.mfa ?? true,
      ...(extra.apiKeyId ? { apiKeyId: extra.apiKeyId } : {}),
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-w17' };
}

const founder = (id: string) => ctxFor(id, ['identity:write']);
const admin = (id: string) => ctxFor(id, ['identity:write', 'admin:write']);
const support = (id: string) => ctxFor(id, ['identity:write', 'support:ops']);

function build(founders: FounderDirectory | null = staticFounderDirectory([F1, F2])) {
  const store = new MemoryActionApprovalStore();
  const service = new ActionApprovalService(store, { ttlSeconds: 60, founders: founders ?? undefined });
  return { store, service, r: createActionApprovalRouter(service, { privilegedUserIds: [F1, F2] }) };
}

const payDeposit = {
  actionType: 'pay.deposit_credit',
  targetService: 'svc-pay',
  targetId: 'pay.deposit_credit',
  expectedVersion: '1',
  payloadHash: HASH_A,
  policyVersion: 'v1',
};
const edgeKill = { ...payDeposit, actionType: 'edge.kill', targetService: 'svc-edge', targetId: 'kill:trade' };
const edgeReenable = { ...edgeKill, targetId: 'kill:pay' };
const marketHalt = { ...payDeposit, actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:market-1' };

const consumeOf = (
  a: { approvalId: string; operationId: string; payloadHash: string; targetId: string; expectedVersion: string },
  svc: string,
) => ({
  approvalId: a.approvalId,
  operationId: a.operationId,
  payloadHash: a.payloadHash,
  targetService: svc,
  targetId: a.targetId,
  expectedVersion: a.expectedVersion,
});

describe('audience table: what each registered approval type needs', () => {
  const T = (actionType: string, targetService: string, targetId: string, expected: ActionAudience) => ({
    actionType,
    targetService,
    targetId,
    expected,
  });
  // Protective verbs (a brake must not need both founders online) are operator; everything that opens or re-enables is founder.
  const protectiveMatching = [
    ['halt', 'halt:market-1'],
    ['halt_all', 'halt_all'],
    ['reduce_only', 'reduce_only:market-1'],
    ['post_only', 'post_only:market-1'],
  ].map(([v, target]) => T(`matching.${v}`, 'svc-matching', target!, 'operator'));
  const matching = [
    ['resume', 'resume:market-1'],
    ['resume_all', 'resume_all'],
    ['reduce_only_resume', 'reduce_only_resume:market-1'],
    ['post_only_resume', 'post_only_resume:market-1'],
    ['prelaunch', 'prelaunch:market-1'],
    ['open', 'open:market-1'],
    ['expire', 'expire:market-1'],
    ['delist', 'delist:market-1'],
  ].map(([v, target]) => T(`matching.${v}`, 'svc-matching', target!, 'founder'));
  const registered = [
    // svc-pay (every pay.* type, including the W16 registry change and deposit credit)
    ...[
      'pay.kyb_decide',
      'pay.psp_set_pricing',
      'pay.psp_enable_mode',
      'pay.merchant_decide_kyb',
      'pay.fraud_resolve_review',
      'pay.fraud_open_dispute',
      'pay.fraud_contest_dispute',
      'pay.deposit_credit',
      'pay.registry_change',
    ].map((t) => T(t, 'svc-pay', t, 'founder')),
    ...protectiveMatching,
    ...matching,
    T('ledger.reconcile', 'svc-ledger', 'posting_reconcile', 'founder'),
    T('ledger.freeze', 'svc-ledger', 'posting_freeze', 'founder'),
    T('ledger.unfreeze', 'svc-ledger', 'posting_unfreeze', 'founder'),
    ...[
      'bank.fund_pool',
      'bank.fund_loan_reserve',
      'bank.seize_loan',
      'bank.abandon_pending_loan',
      'bank.card_authorize',
      'bank.card_capture',
      'bank.card_reverse',
      'bank.card_resume_settlement',
      'bank.fund_cashback_pot',
      'bank.credit_onramp',
    ].map((t) => T(t, 'svc-bank', t, 'founder')),
    T('token.revenue.distribute', 'svc-token', 'token.revenue.distribute', 'founder'),
    T('token.buyback.record', 'svc-token', 'token.buyback.record', 'founder'),
    T('identity.change_fee_tier', 'svc-identity', 'identity.change_fee_tier', 'founder'),
    T('identity.change_limit', 'svc-identity', 'identity.change_limit', 'founder'),
    T('identity.account_tier_move', 'svc-identity', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'founder'),
    T('affiliates.payout', 'svc-identity', 'affiliates.payout', 'founder'),
    // operator-level: judged not to move money or a venue (see the report)
    T('edge.kill', 'svc-edge', 'kill:trade', 'founder'),
    T('edge.kill', 'svc-edge', 'kill:pay', 'founder'),
    T('trading.restrict', 'svc-identity', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'trade_ops'),
    T('trading.restrict', 'svc-trade', '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'founder'),
    T('market.vendor.vet', 'svc-market', 'market.vendor.vet', 'operator'),
    T('p2p.method_register', 'svc-p2p', 'p2p.method_register', 'operator'),
    T('p2p.method_set_enabled', 'svc-p2p', 'p2p.method_set_enabled', 'operator'),
    T('p2p.merchants_decide', 'svc-p2p', 'p2p.merchants_decide', 'operator'),
    ...[
      'academy.ambassador.appoint',
      'academy.ambassador.freeze',
      'academy.ambassador.unfreeze',
      'academy.residency.decide',
      'academy.season.create',
      'academy.season.setStatus',
      'academy.standing.set',
      'academy.standing.bulk',
    ].map((t) => T(t, 'svc-academy', t, 'operator')),
    ...[
      'kyc.approve',
      'kyc.reject',
      'kyc.capabilities.set',
      'kyc.doc.store',
      'kyc.doc.get',
      'kyc.doc.bind',
      'affiliates.freeze',
      'affiliates.unfreeze',
    ].map((t) => T(t, 'svc-identity', t, 'operator')),
    ...['identity.freeze', 'identity.unfreeze', 'identity.disable_user'].map((t) => T(t, 'svc-identity', t, 'operator')),
  ];

  it.each(registered)('$actionType -> $expected', ({ actionType, targetService, targetId, expected }) => {
    expect(audienceOfApproval({ actionType, targetService, targetId })).toBe(expected);
  });

  it('same-person step-up types stay self', () => {
    for (const t of SAME_PERSON_ACTION_TYPES) {
      expect(audienceOf(t)).toBe('self');
      expect(audienceOfApproval({ actionType: t, targetService: 'svc-bank', targetId: t, kind: 'same_person' })).toBe('self');
    }
  });

  it('an unknown type is operator, never open', () => {
    expect(audienceOf('some.unregistered.thing')).toBe('operator');
    expect(audienceOf('')).toBe('operator');
  });

  it('is decided from the whole request: a founder target filed under a harmless type, or a different case, is still founder', () => {
    expect(audienceOfApproval({ actionType: 'harmless.note', targetService: 'svc-pay', targetId: 'whatever' })).toBe('founder');
    expect(audienceOfApproval({ actionType: 'harmless.note', targetService: 'svc-x', targetId: 'pay.deposit_credit' })).toBe('founder');
    expect(audienceOfApproval({ actionType: 'harmless.note', targetService: 'svc-edge', targetId: 'open:market-1' })).toBe('operator');
    expect(audienceOfApproval({ actionType: 'harmless.note', targetService: 'svc-x', targetId: 'matching.open' })).toBe('founder');
    expect(audienceOfApproval({ actionType: ' Pay.Deposit_Credit ', targetService: 'svc-x', targetId: 'x' })).toBe('founder');
    expect(audienceOfApproval({ actionType: 'harmless.note', targetService: ' SVC-LEDGER ', targetId: 'x' })).toBe('founder');
  });
});

describe('protective verbs, unknown services and the self kind', () => {
  const sub = (actionType: string, targetService: string, targetId: string, kind?: 'four_eyes' | 'same_person') => ({
    actionType,
    targetService,
    targetId,
    kind,
  });

  it('is operator for exactly the shared protective list, and founder for a verb that list does not name on the same services', () => {
    for (const row of PROTECTIVE_OPERATOR_APPROVALS) {
      const targetId = row.targetService === 'svc-ledger' || row.targetVerb === 'halt_all' ? row.targetVerb : `${row.targetVerb}:market-1`;
      expect(audienceOfApproval(sub(row.actionType, row.targetService, targetId))).toBe(
        row.actionType === 'ledger.freeze' ? 'founder' : 'operator',
      );
    }
    expect(audienceOfApproval(sub('matching.resume', 'svc-matching', 'resume:market-1'))).toBe('founder');
    expect(audienceOfApproval(sub('ledger.unfreeze', 'svc-ledger', 'posting_unfreeze'))).toBe('founder');
  });

  it('a protective verb is operator only when type, service and target verb all agree', () => {
    expect(audienceOfApproval(sub('matching.halt', 'svc-matching', 'halt:market-1'))).toBe('operator');
    expect(audienceOfApproval(sub('ledger.freeze', 'svc-ledger', 'posting_freeze'))).toBe('founder');
    // type says halt but the target opens a market
    expect(audienceOfApproval(sub('matching.halt', 'svc-matching', 'open:market-1'))).toBe('founder');
    // type says halt but the target is another service, or the target is the unfreeze verb
    expect(audienceOfApproval(sub('matching.halt', 'svc-pay', 'halt:market-1'))).toBe('founder');
    expect(audienceOfApproval(sub('ledger.freeze', 'svc-ledger', 'posting_unfreeze'))).toBe('founder');
    // a harmless type filed against a halt target is not the protective exception
    expect(audienceOfApproval(sub('harmless.note', 'svc-matching', 'halt:market-1'))).toBe('founder');
    // the re-enabling verbs are never protective
    for (const [t, id] of [
      ['matching.resume', 'resume:market-1'],
      ['matching.reduce_only_resume', 'reduce_only_resume:market-1'],
      ['ledger.unfreeze', 'posting_unfreeze'],
    ] as const) {
      expect(audienceOfApproval(sub(t, t.startsWith('ledger') ? 'svc-ledger' : 'svc-matching', id))).toBe('founder');
    }
  });

  it('two plain operators can complete a halt end to end, and a founder-only resume still needs the founders', async () => {
    const { r } = build();
    const a1 = r.createCaller(await admin(ADMIN));
    const a2 = r.createCaller(await admin(ADMIN2));
    const halt = { ...payDeposit, actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:market-1' };
    const pending = await a1.actionApproval.propose(halt);
    await expect(a2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).resolves.toMatchObject({
      status: 'APPROVED',
    });
    const resume = { ...halt, actionType: 'matching.resume', targetId: 'resume:market-1' };
    await expect(a1.actionApproval.propose(resume)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a target service that is not on the operator list is founder-only, including one that does not exist yet', () => {
    expect(audienceOfApproval(sub('newthing.do_it', 'svc-newmoney', 'newthing.do_it'))).toBe('founder');
    expect(audienceOfApproval(sub('harmless.note', 'svc-treasury', 'x'))).toBe('founder');
    expect(audienceOfApproval(sub('harmless.note', 'svc-trade', 'x'))).toBe('founder');
    for (const svc of ['svc-edge', 'svc-market', 'svc-academy', 'svc-p2p', 'svc-identity']) {
      expect(audienceOfApproval(sub('harmless.note', svc, 'x'))).toBe('operator');
    }
  });

  it('a made-up money service is refused to an admin operator at the door', async () => {
    const { r } = build();
    const input = { ...payDeposit, actionType: 'newthing.do_it', targetService: 'svc-newmoney', targetId: 'newthing.do_it' };
    await expect(r.createCaller(await admin(ADMIN)).actionApproval.propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(r.createCaller(await founder(F1)).actionApproval.propose(input)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('self counts only for a stored same_person row; a four-eyes request with a step-up type is judged by type and target', async () => {
    const stepUp = 'bank.step_up.transfers.toUser';
    expect(audienceOfApproval(sub(stepUp, 'svc-bank', stepUp, 'same_person'))).toBe('self');
    expect(audienceOfApproval(sub(stepUp, 'svc-bank', stepUp))).toBe('founder');
    expect(audienceOfApproval(sub(stepUp, 'svc-bank', stepUp, 'four_eyes'))).toBe('founder');
    // at the door: an admin operator is refused, a founder is told it is the wrong door (not skipped)
    const { r } = build();
    const input = { ...payDeposit, actionType: stepUp, targetService: 'svc-bank', targetId: stepUp };
    await expect(r.createCaller(await admin(ADMIN)).actionApproval.propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(r.createCaller(await founder(F1)).actionApproval.propose(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a four-eyes row that carries a step-up type gets the founder check at approve and consume, not a skip', async () => {
    const { r, service, store } = build();
    const stepUp = 'bank.step_up.transfers.toUser';
    const row = await seedApproved(
      store,
      { requesterId: ADMIN, approverId: ADMIN2 },
      { actionType: stepUp, targetService: 'svc-bank', targetId: stepUp },
    );
    await expect(service.consume('svc-bank', consumeOf(row, 'svc-bank'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
    const pendingRow = await seedApproved(
      store,
      { requesterId: F1, approverId: F2 },
      {
        actionType: stepUp,
        targetService: 'svc-bank',
        targetId: stepUp,
        status: 'PENDING',
        approverId: null,
        approvedAt: null,
      },
    );
    await expect(
      r.createCaller(await admin(ADMIN)).actionApproval.approve({ approvalId: pendingRow.approvalId, expectedPayloadHash: HASH_A }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('founder-only types at the door (propose, approve, reject)', () => {
  it('an admin:* operator and a support:ops operator cannot propose a founder type', async () => {
    const { r } = build();
    for (const who of [await admin(ADMIN), await support(SUPPORT)]) {
      await expect(r.createCaller(who).actionApproval.propose(payDeposit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('an admin:* operator and a support:ops operator cannot approve or reject a founder approval a founder proposed', async () => {
    const { r } = build();
    const f1 = r.createCaller(await founder(F1));
    const pending = await f1.actionApproval.propose(payDeposit);
    for (const who of [await admin(ADMIN), await admin(ADMIN2), await support(SUPPORT)]) {
      const c = r.createCaller(who);
      await expect(c.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(c.actionApproval.reject({ approvalId: pending.approvalId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // still pending: a founder completes it
    await expect(
      r.createCaller(await founder(F2)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
    ).resolves.toMatchObject({ status: 'APPROVED', approverId: F2 });
  });

  it('an admin:* operator cannot consume a founder type approval proposed and approved by non-founders', async () => {
    // Operators who are not founders get a row approved some other way (a pre-existing row): it cannot be consumed.
    const { r, store } = build();
    const row = await seedApproved(store, { requesterId: ADMIN, approverId: ADMIN2 });
    await expect(
      r
        .createCaller({ principal: null, service: 'svc-pay', region: 'DE', requestId: 'x' })
        .actionApproval.consume(consumeOf(row, 'svc-pay')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a founder pair completes a founder type end to end and the consume is attested', async () => {
    const { r } = build();
    const f1 = r.createCaller(await founder(F1));
    const f2 = r.createCaller(await founder(F2));
    const pending = await f1.actionApproval.propose(payDeposit);
    const approved = await f2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A });
    const consumed = await r
      .createCaller({ principal: null, service: 'svc-pay', region: 'DE', requestId: 'x' })
      .actionApproval.consume(consumeOf(approved, 'svc-pay'));
    expect(consumed).toMatchObject({
      status: 'CONSUMED',
      approverId: F2,
      requesterId: F1,
      approverIsFounder: true,
      requesterIsFounder: true,
    });
    expect(actionApprovalSchema.safeParse(consumed).success).toBe(true);
  });

  it('the proposer cannot approve their own founder approval', async () => {
    const { r } = build();
    const f1 = r.createCaller(await founder(F1));
    const pending = await f1.actionApproval.propose(payDeposit);
    await expect(f1.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('action_approval.same_person'),
    });
  });

  it('a founder id on an API key, a sub-account or a session without MFA is not a founder at the door', async () => {
    const { r } = build();
    const viaKey = r.createCaller(await ctxFor(F1, ['identity:write'], { apiKeyId: 'key-1' }));
    await expect(viaKey.actionApproval.propose(payDeposit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const noMfa = r.createCaller(await ctxFor(F1, ['identity:write'], { mfa: false }));
    await expect(noMfa.actionApproval.propose(payDeposit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a founder whose entitlement is revoked (directory says no) is refused at the door', async () => {
    const live = new Set([F1, F2]);
    const { r } = build({ isFounder: async (id) => live.has(id) });
    const f1 = r.createCaller(await founder(F1));
    const pending = await f1.actionApproval.propose(payDeposit);
    live.delete(F2);
    await expect(
      r.createCaller(await founder(F2)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unwired founder directory refuses every founder type (fail closed), including for the founder ids', async () => {
    const { r } = build(null);
    await expect(r.createCaller(await founder(F1)).actionApproval.propose(payDeposit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('filing a founder action under a harmless type name is still founder-only', async () => {
    const { r } = build();
    const spoof = { ...payDeposit, actionType: 'harmless.note', targetService: 'svc-pay' };
    await expect(r.createCaller(await admin(ADMIN)).actionApproval.propose(spoof)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(r.createCaller(await founder(F1)).actionApproval.propose(spoof)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('a market halt still completes with two admin operators', async () => {
    const { r } = build();
    const a1 = r.createCaller(await admin(ADMIN));
    const a2 = r.createCaller(await admin(ADMIN2));
    const pending = await a1.actionApproval.propose(marketHalt);
    const approved = await a2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A });
    expect(approved.status).toBe('APPROVED');
    const consumed = await r
      .createCaller({ principal: null, service: 'svc-matching', region: 'DE', requestId: 'x' })
      .actionApproval.consume(consumeOf(approved, 'svc-matching'));
    expect(consumed).toMatchObject({ status: 'CONSUMED' });
    // operator types carry no founder attestation
    expect(consumed.approverIsFounder).toBeUndefined();
  });
});

describe('payload hash binding on approve', () => {
  it('refuses a mismatched expectedPayloadHash with a typed code and accepts the matching one', async () => {
    const { r } = build();
    const f1 = r.createCaller(await founder(F1));
    const f2 = r.createCaller(await founder(F2));
    const pending = await f1.actionApproval.propose(payDeposit);
    await expect(f2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_B })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('action_approval.payload_mismatch'),
    });
    // the refusal did not approve it
    await expect(f2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).resolves.toMatchObject({
      status: 'APPROVED',
    });
  });

  it('refuses an approve with no expectedPayloadHash at the door (an id alone is not approval)', async () => {
    const { r } = build();
    const f1 = r.createCaller(await founder(F1));
    const f2 = r.createCaller(await founder(F2));
    const pending = await f1.actionApproval.propose(payDeposit);
    await expect(f2.actionApproval.approve({ approvalId: pending.approvalId } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('service level: typed payload_mismatch on a different hash, a prefix of it, or an empty one; the row stays pending', async () => {
    const { service } = build();
    const pending = await service.propose(F1, payDeposit);
    for (const wrong of [HASH_B, HASH_A.slice(0, -1), `${HASH_A}0`, '']) {
      await expect(service.approve(F2, pending.approvalId, wrong)).rejects.toMatchObject({ code: 'action_approval.payload_mismatch' });
    }
    await expect(service.approve(F2, pending.approvalId, HASH_A)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('payloadHashesEqual is exact for equal-length and different-length inputs', () => {
    expect(payloadHashesEqual(HASH_A, HASH_A)).toBe(true);
    expect(payloadHashesEqual(HASH_A, HASH_B)).toBe(false);
    expect(payloadHashesEqual(HASH_A, HASH_A.slice(0, 10))).toBe(false);
    expect(payloadHashesEqual('', '')).toBe(true);
  });

  it('operator-type approvals are bound the same way', async () => {
    const { r } = build();
    const a1 = r.createCaller(await admin(ADMIN));
    const a2 = r.createCaller(await admin(ADMIN2));
    const pending = await a1.actionApproval.propose(marketHalt);
    await expect(a2.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_B })).rejects.toMatchObject({
      message: expect.stringContaining('action_approval.payload_mismatch'),
    });
  });
});

async function seedApproved(
  store: MemoryActionApprovalStore,
  who: { requesterId: string; approverId: string },
  over: Partial<StoredApproval> = {},
): Promise<StoredApproval> {
  const ids = newApprovalIds();
  const now = new Date();
  return store.insert({
    approvalId: ids.approvalId,
    actionType: 'pay.deposit_credit',
    targetService: 'svc-pay',
    targetId: 'pay.deposit_credit',
    expectedVersion: '1',
    payloadHash: HASH_A,
    requesterId: who.requesterId,
    approverId: who.approverId,
    policyVersion: 'v1',
    operationId: ids.operationId,
    status: 'APPROVED',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    approvedAt: now,
    consumedAt: null,
    ...over,
  });
}

describe('consume re-checks the approver and the proposer (no grandfathering)', () => {
  it('refuses a pre-existing APPROVED founder-type row approved by a non-founder', async () => {
    const { service, store } = build();
    const row = await seedApproved(store, { requesterId: F1, approverId: ADMIN });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
    // not consumed: the failed check burns nothing
    expect((await store.get(row.approvalId))?.status).toBe('APPROVED');
  });

  it('refuses a pre-existing APPROVED row proposed by a non-founder, even when a founder approved it', async () => {
    const { service, store } = build();
    const row = await seedApproved(store, { requesterId: ADMIN, approverId: F2 });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
  });

  it('refuses when the approver and the proposer are the same founder', async () => {
    const { service, store } = build();
    const row = await seedApproved(store, { requesterId: F1, approverId: F1 });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toBeInstanceOf(ActionApprovalError);
  });

  it('refuses when a founder lost the entitlement between approve and consume', async () => {
    const live = new Set([F1, F2]);
    const { service } = build({ isFounder: async (id) => live.has(id) });
    const pending = await service.propose(F1, payDeposit);
    const approved = await service.approve(F2, pending.approvalId, HASH_A);
    live.delete(F2);
    await expect(service.consume('svc-pay', consumeOf(approved, 'svc-pay'))).rejects.toMatchObject({
      code: 'action_approval.founder_only',
    });
  });

  it('refuses closed when no founder directory is wired', async () => {
    const { service, store } = build(null);
    const row = await seedApproved(store, { requesterId: F1, approverId: F2 });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
  });

  it('a founder directory that cannot answer is founders_unavailable (still refused, row not burned), distinct from founder_only', async () => {
    const { service, store } = build({
      isFounder: async () => {
        throw new Error('db down');
      },
    });
    const row = await seedApproved(store, { requesterId: F1, approverId: F2 });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toMatchObject({
      code: 'action_approval.founders_unavailable',
    });
    expect((await store.get(row.approvalId))?.status).toBe('APPROVED');
  });

  it('an outage at the door is SERVICE_UNAVAILABLE on propose, approve and consume, and operator types are unaffected', async () => {
    const { r, store, service } = build({
      isFounder: async () => {
        throw new Error('db down');
      },
    });
    await expect(r.createCaller(await founder(F1)).actionApproval.propose(payDeposit)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('action_approval.founders_unavailable'),
    });
    const row = await seedApproved(store, { requesterId: F1, approverId: F2 });
    await expect(
      r
        .createCaller({ principal: null, service: 'svc-pay', region: 'DE', requestId: 'x' })
        .actionApproval.consume(consumeOf(row, 'svc-pay')),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const pending = await service.propose(ADMIN, marketHalt);
    await expect(service.approve(ADMIN2, pending.approvalId, HASH_A)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('a founder-target row filed under a harmless type is checked at consume too', async () => {
    const { service, store } = build();
    const row = await seedApproved(store, { requesterId: ADMIN, approverId: ADMIN2 }, { actionType: 'harmless.note' });
    await expect(service.consume('svc-pay', consumeOf(row, 'svc-pay'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
  });

  it('approve itself refuses a non-founder approver of a founder type at the service, not just the door', async () => {
    const { service } = build();
    const pending = await service.propose(F1, payDeposit);
    await expect(service.approve(ADMIN, pending.approvalId, HASH_A)).rejects.toMatchObject({ code: 'action_approval.founder_only' });
  });

  it('two founders consume once; replay is refused', async () => {
    const { service } = build();
    const pending = await service.propose(F1, payDeposit);
    const approved = await service.approve(F2, pending.approvalId, HASH_A);
    await expect(service.consume('svc-pay', consumeOf(approved, 'svc-pay'))).resolves.toMatchObject({
      status: 'CONSUMED',
      approverIsFounder: true,
      requesterIsFounder: true,
    });
    await expect(service.consume('svc-pay', consumeOf(approved, 'svc-pay'))).rejects.toMatchObject({ code: 'action_approval.consumed' });
  });

  it('operator-only types still consume with no founder directory at all', async () => {
    const { service } = build(null);
    const pending = await service.propose(ADMIN, marketHalt);
    const approved = await service.approve(ADMIN2, pending.approvalId, HASH_A);
    await expect(service.consume('svc-matching', consumeOf(approved, 'svc-matching'))).resolves.toMatchObject({ status: 'CONSUMED' });
  });
});

describe('consume compares the payload hash in constant time and still refuses a mismatch', () => {
  it('refuses a different, shorter or empty payload hash at consume with the typed code', async () => {
    const { service } = build();
    const pending = await service.propose(F1, payDeposit);
    const approved = await service.approve(F2, pending.approvalId, HASH_A);
    for (const wrong of [HASH_B, HASH_A.slice(0, -1), '']) {
      await expect(service.consume('svc-pay', { ...consumeOf(approved, 'svc-pay'), payloadHash: wrong })).rejects.toMatchObject({
        code: 'action_approval.payload_mismatch',
      });
    }
    await expect(service.consume('svc-pay', consumeOf(approved, 'svc-pay'))).resolves.toMatchObject({ status: 'CONSUMED' });
  });
});

describe('founder-level kill, freeze and unfreeze', () => {
  const freeze = { ...payDeposit, actionType: 'ledger.freeze', targetService: 'svc-ledger', targetId: 'posting_freeze' };
  const unfreeze = { ...freeze, actionType: 'ledger.unfreeze', targetId: 'posting_unfreeze' };

  it('refuses an admin:* operator on edge.kill (kill and re-enable); a different founder approves; the requester cannot', async () => {
    const { r } = build();
    const maker = r.createCaller(await founder(F1));
    const checker = r.createCaller(await founder(F2));
    const operator = r.createCaller(await admin(ADMIN));
    for (const input of [edgeKill, edgeReenable]) {
      await expect(operator.actionApproval.propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const pending = await maker.actionApproval.propose(input);
      await expect(operator.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('action_approval.founder_only'),
      });
      await expect(maker.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('action_approval.same_person'),
      });
      await expect(checker.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).resolves.toMatchObject({
        status: 'APPROVED',
        approverId: F2,
      });
    }
  });

  it('refuses an admin:* operator on ledger.freeze and ledger.unfreeze', async () => {
    const { r } = build();
    const maker = r.createCaller(await founder(F1));
    const operator = r.createCaller(await admin(ADMIN));
    for (const input of [freeze, unfreeze]) {
      await expect(operator.actionApproval.propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const pending = await maker.actionApproval.propose(input);
      await expect(operator.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        r.createCaller(await founder(F2)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
      ).resolves.toMatchObject({ status: 'APPROVED' });
    }
  });

  it('re-checks a pending edge.kill that was stored before this audience, at approve time', async () => {
    const { r, store } = build();
    const ids = newApprovalIds();
    const now = new Date();
    await store.insert({
      approvalId: ids.approvalId,
      actionType: 'edge.kill',
      targetService: 'svc-edge',
      targetId: 'kill:trade',
      expectedVersion: '1',
      payloadHash: HASH_A,
      requesterId: F1,
      approverId: null,
      policyVersion: 'v1',
      operationId: ids.operationId,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      approvedAt: null,
      consumedAt: null,
    });
    await expect(
      r.createCaller(await admin(ADMIN)).actionApproval.approve({ approvalId: ids.approvalId, expectedPayloadHash: HASH_A }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      r.createCaller(await founder(F2)).actionApproval.approve({ approvalId: ids.approvalId, expectedPayloadHash: HASH_A }),
    ).resolves.toMatchObject({ status: 'APPROVED', approverId: F2 });
  });

  it('a market halt still accepts its operator audience', async () => {
    const { r } = build();
    const pending = await r.createCaller(await admin(ADMIN)).actionApproval.propose(marketHalt);
    await expect(
      r.createCaller(await admin(ADMIN2)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
    ).resolves.toMatchObject({ status: 'APPROVED', approverId: ADMIN2 });
  });

  it('trading.restrict needs the trade-ops permission and a different principal', async () => {
    const { r } = build();
    const restrict = { ...payDeposit, actionType: 'trading.restrict', targetService: 'svc-identity', targetId: F1 };
    await expect(r.createCaller(await support(SUPPORT)).actionApproval.propose(restrict)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('action_approval.trade_ops_only'),
    });
    await expect(r.createCaller(await ctxFor(ADMIN, ['market:ops'])).actionApproval.propose(restrict)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const pending = await r.createCaller(await admin(ADMIN)).actionApproval.propose(restrict);
    await expect(
      r.createCaller(await admin(ADMIN)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('action_approval.same_person') });
    await expect(
      r.createCaller(await admin(ADMIN2)).actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: HASH_A }),
    ).resolves.toMatchObject({ status: 'APPROVED', approverId: ADMIN2 });
  });
});
