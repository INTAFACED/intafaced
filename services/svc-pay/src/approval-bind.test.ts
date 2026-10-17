import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_PAYLOAD_MISMATCH,
  stubApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { fraudOpenDisputePayloadHash, fraudResolveReviewPayloadHash, merchantProfileReviewPayloadHash } from './approval-bindings.js';
import { MemoryDisputeCaseStore } from './fraud/dispute-case.js';
import { evaluateFraud } from './fraud/evaluate.js';
import { defaultFraudReviewQueue } from './fraud/review-queue.js';
import { createMerchantPortalRouter } from './merchant-portal/router.js';
import type { PayService } from './payment-service.js';
import { createPayRouter } from './router.js';
import type { RailRegistry } from './rails/registry.js';
import type { UserMoneyService } from './user-money-service.js';

/**
 * An approved payload is consumed only when execute sends the same bound fields.
 * The consumer stands in for identity: a different hash is `action_approval.payload_mismatch`.
 */

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = '66666666-6666-4666-8666-666666666666';
const CONFIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '44444444-4444-4444-8444-444444444444';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };

async function ctx(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

function bindingConsumer(approvedHash: string, seen: string[]): ActionApprovalConsumer {
  return {
    async consume(input) {
      seen.push(input.payloadHash);
      if (input.payloadHash !== approvedHash) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', ACTION_APPROVAL_PAYLOAD_MISMATCH);
      }
      return stubApprovalConsumer(CONFIRM).consume(input);
    },
  };
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe('fraud.openDispute binds reasonCode and markPaymentDisputed', () => {
  const disputeId = `dsp-bind-${randomUUID()}`;
  const approved = {
    disputeId,
    paymentId: PAYMENT,
    merchantId: MERCHANT,
    amount: '40.50',
    assetId: 'USDT',
    reasonCode: '4853' as string | null,
    markPaymentDisputed: true,
  };

  function routerFor(hash: string) {
    const seen: string[] = [];
    const marks: Array<{ paymentId: string; reasonCode: string | null }> = [];
    const disputes = new MemoryDisputeCaseStore();
    const pay = {
      async markDisputed(paymentId: string, meta: { reasonCode?: string | null }) {
        marks.push({ paymentId, reasonCode: meta.reasonCode ?? null });
        return {};
      },
      async openChargeback() {
        return { txId: 'tx-bind-1' };
      },
    } as unknown as PayService;
    const api = createPayRouter(
      pay,
      {} as RailRegistry,
      {} as UserMoneyService,
      null,
      undefined,
      bindingConsumer(hash, seen),
      null,
      disputes,
    );
    return { api, seen, marks, disputes };
  }

  it('refuses execute when reasonCode differs from the approved payload, and does not open the case', async () => {
    const { api, marks, disputes } = routerFor(fraudOpenDisputePayloadHash(approved));
    const caller = (await api).createCaller(await ctx(['admin:treasury']));
    await expect(
      caller.fraud.openDispute({ ...approved, reasonCode: '4855', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.fraud.openDispute({ ...approved, reasonCode: '4855', confirmOperatorId: CONFIRM, ...APPROVED })).rejects.toSatisfy(
      (err: unknown) => codeOf(err) === ACTION_APPROVAL_PAYLOAD_MISMATCH,
    );
    expect(marks).toEqual([]);
    expect(disputes.get(disputeId)).toBeNull();
  });

  it('refuses execute when markPaymentDisputed differs from the approved payload', async () => {
    const { api, marks, disputes } = routerFor(fraudOpenDisputePayloadHash(approved));
    const caller = (await api).createCaller(await ctx(['admin:treasury']));
    await expect(
      caller.fraud.openDispute({ ...approved, markPaymentDisputed: false, confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toSatisfy((err: unknown) => codeOf(err) === ACTION_APPROVAL_PAYLOAD_MISMATCH);
    expect(marks).toEqual([]);
    expect(disputes.get(disputeId)).toBeNull();
  });

  it('executes an unchanged payload, including the approved reason and disputed mark', async () => {
    const { api, marks, disputes } = routerFor(fraudOpenDisputePayloadHash(approved));
    const caller = (await api).createCaller(await ctx(['admin:treasury']));
    const opened = await caller.fraud.openDispute({ ...approved, confirmOperatorId: CONFIRM, ...APPROVED });
    expect(opened).toMatchObject({
      disputeId,
      status: 'open',
      paymentMarkedDisputed: true,
      confirmOperatorId: CONFIRM,
    });
    expect(marks).toEqual([{ paymentId: PAYMENT, reasonCode: '4853' }]);
    expect(disputes.get(disputeId)).toMatchObject({ reasonCode: '4853', paymentMarkedDisputed: true });
  });
});

describe('fraud.resolveReview binds the resolution note', () => {
  it('refuses a different note, then resolves when the note matches', async () => {
    const id = `rev-bind-${randomUUID()}`;
    const decision = evaluateFraud({
      merchantId: MERCHANT,
      amount: '99',
      assetId: 'USDT',
      recentPaymentCount: 50,
      thresholds: { maxPaymentsInWindow: 5, velocityCountAction: 'review' },
    });
    defaultFraudReviewQueue.enqueue({ id, merchantId: MERCHANT, amount: '99', assetId: 'USDT', decision });
    const approved = { id, outcome: 'allow' as const, note: 'known payer' };
    const seen: string[] = [];
    const api = createPayRouter(
      {} as PayService,
      {} as RailRegistry,
      {} as UserMoneyService,
      null,
      undefined,
      bindingConsumer(fraudResolveReviewPayloadHash(approved), seen),
    );
    const caller = api.createCaller(await ctx(['admin:treasury']));
    await expect(
      caller.fraud.resolveReview({ id, outcome: 'allow', note: 'other note', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toSatisfy((err: unknown) => codeOf(err) === ACTION_APPROVAL_PAYLOAD_MISMATCH);
    expect(defaultFraudReviewQueue.get(id)?.status).toBe('open');
    const resolved = await caller.fraud.resolveReview({
      id,
      outcome: 'allow',
      note: 'known payer',
      confirmOperatorId: CONFIRM,
      ...APPROVED,
    });
    expect(resolved).toMatchObject({ id, status: 'allowed', confirmOperatorId: CONFIRM });
    expect(defaultFraudReviewQueue.get(id)?.resolutionNote).toBe('known payer');
  });
});

describe('merchant profile review binds the checker reason', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const changeHash = `sha256:${'ab'.repeat(32)}`;
  const approved = {
    merchantId: MERCHANT,
    requestId,
    decision: 'rejected' as const,
    expectedChangeHash: changeHash,
    reason: 'dossier mismatch',
  };

  it('refuses a different reason before the profile write, and consumes when the reason matches', async () => {
    let reviewed = false;
    const sql = Object.assign(async () => [{ status: 'pending_review', change_hash: changeHash }], {
      begin() {
        reviewed = true;
        throw new Error('profile-review-reached');
      },
    }) as unknown as Sql;
    const seen: string[] = [];
    const api = createMerchantPortalRouter({
      sql,
      pay: {} as PayService,
      trees: null,
      team: { allows: async () => false, activeRole: async () => null },
      approvals: bindingConsumer(merchantProfileReviewPayloadHash(approved), seen),
    });
    const caller = api.createCaller(await ctx(['admin:compliance']));
    const review = (reason: string) =>
      caller.merchant.businessProfile.review({ ...approved, reason, confirmOperatorId: CONFIRM, ...APPROVED });
    await expect(review('other reason')).rejects.toSatisfy((err: unknown) => codeOf(err) === ACTION_APPROVAL_PAYLOAD_MISMATCH);
    expect(reviewed).toBe(false);
    await expect(review('dossier mismatch')).rejects.toThrow(/profile-review-reached/);
    expect(reviewed).toBe(true);
    expect(seen[1]).toBe(merchantProfileReviewPayloadHash(approved));
  });
});
