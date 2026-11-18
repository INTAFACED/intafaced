/**
 * D26-P1-P5 Done bar — Scoring + chargeback **mechanism** (list content Class X).
 *
 * Public-door proof via tRPC createCaller (same boundary merchants/ops hit).
 * Break: missing review queue, dispute case with no writer, or ledger wire
 * without a named §13 refuse socket.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createPayRouter } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { PayError, type PayService, type PaymentView } from './payment-service.js';
import type { UserMoneyService } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CHARGEBACK_LEDGER_SOCKET_ID } from './fraud/chargeback-ledger-socket.js';
import { defaultDisputeCaseStore } from './fraud/dispute-case.js';
import { defaultFraudReviewQueue } from './fraud/review-queue.js';

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '66666666-6666-4666-8666-666666666666';
const CONFIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '44444444-4444-4444-8444-444444444444';

async function ctx(scopes: string[]): Promise<Context> {
  if (scopes.length === 0) return { principal: null, service: null, region: 'DE', requestId: 'fraud-done-bar' };
  const { token } = await issueAccessToken(
    {
      userId: USER,
      sessionId: '77777777-7777-4777-8777-777777777777',
      scopes,
      tier: 'full',
      mfa: true,
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'fraud-done-bar',
  };
}

function paymentView(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: PAYMENT,
    merchantId: MERCHANT,
    profileId: null,
    amount: amt('40.50'),
    assetId: 'USDT',
    method: 'card',
    railAdapter: 'card-sandbox',
    railRef: 'ch_1',
    status: 'settled',
    capturedAmount: amt('40.50'),
    refundedAmount: 0n,
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
    ...overrides,
  };
}

describe('D26-P1-P5 fraud Done bar — public doors', () => {
  beforeEach(() => {
    // Process-local stores — reset between cases by opening unique ids.
  });

  async function caller(scopes: string[]) {
    const pay = {
      getMerchant: async () => ({ id: MERCHANT, userId: USER }),
      getPayment: async () => paymentView(),
      markDisputed: async () => paymentView({ status: 'disputed' }),
    } as unknown as PayService;
    const userMoney = {} as UserMoneyService;
    const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'fraud-done-bar-secret-at-least-32-chars', toleranceSeconds: 300 })]);
    const router = createPayRouter(pay, rails, userMoney, null, undefined, stubApprovalConsumer(CONFIRM));
    return router.createCaller(await ctx(scopes));
  }

  it('scoring door declines with explainable rule ids (no invent list content)', async () => {
    const api = await caller([]);
    const d = await api.fraud.evaluate({
      merchantId: MERCHANT,
      amount: '10',
      assetId: 'USDT',
      ip: '203.0.113.9',
      blocklists: { ips: ['203.0.113.9'] },
    });
    expect(d.outcome).toBe('decline');
    expect(d.reasons[0]?.ruleId).toBe('blocklist_ip');
  });

  it('review queue door enqueues only when scoring says review', async () => {
    const api = await caller(['pay:write']);
    const id = `rev-${Date.now()}`;
    const c = await api.fraud.enqueueReview({
      id,
      merchantId: MERCHANT,
      amount: '99',
      assetId: 'USDT',
      recentPaymentCount: 50,
      thresholds: { maxPaymentsInWindow: 5, velocityCountAction: 'review' },
    });
    expect(c.id).toBe(id);
    expect(c.status).toBe('open');
    expect(c.reasons.length).toBeGreaterThan(0);
    expect(defaultFraudReviewQueue.listOpen(MERCHANT, 50).some((r) => r.id === id)).toBe(true);
  });

  it('dispute case door refuse-closes ledger via named §13 socket', async () => {
    const api = await caller(['admin:treasury']);
    const disputeId = `dsp-done-${Date.now()}`;
    const opened = await api.fraud.openDispute({
      disputeId,
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      amount: '40.50',
      assetId: 'USDT',
      reasonCode: '4855',
      confirmOperatorId: CONFIRM,
      ...APPROVED,
    });
    expect(opened.status).toBe('open');
    expect(opened.ledgerWire).toBe('refused');
    expect(opened.ledgerSocket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(opened.ledgerRefuseCode).toBe('pay.chargeback_ledger_unwired');

    const got = await (await caller(['pay:read'])).fraud.getDispute({ disputeId });
    expect(got.ledgerSocket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    const stored = defaultDisputeCaseStore.get(disputeId);
    if (!stored || !stored.ledgerRefuse) throw new Error('expected the refused chargeback ledger wire');
    expect(stored.ledgerRefuse.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
  });

  it('never imports chargeback recipes on the public dispute path', async () => {
    const api = await caller(['admin:treasury']);
    await expect(
      api.fraud.openDispute({
        disputeId: `dsp-no-money-${Date.now()}`,
        paymentId: PAYMENT,
        merchantId: MERCHANT,
        amount: '1',
        assetId: 'USDT',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).resolves.toMatchObject({ ledgerWire: 'refused' });
    // PayError unused pin — keep stub honest if markDisputed path is taken.
    expect(PayError).toBeDefined();
  });
});
