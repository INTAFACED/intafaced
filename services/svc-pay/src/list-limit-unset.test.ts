import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import { PAY_PAYMENT_HISTORY } from '@intafaced/contracts/pay-payment-procedures';
import { PAY_MERCHANT_LIST_LINKS } from '@intafaced/contracts/pay-merchant-procedures';
import { PAY_ACCOUNT_CONTROLS_HISTORY } from '@intafaced/contracts/pay-account-controls-procedures';
import { accountControlHistoryInputSchema } from '@intafaced/contracts/account-controls';
import { describe, expect, it, vi } from 'vitest';
import {
  PayError,
  PayService,
  assertDueSubscriptionsBatchLimit,
  assertDueWebhookDeliveriesBatchLimit,
  assertCycleListLimit,
  assertExecutionListLimit,
  assertMandateListLimit,
  assertPaymentHistoryLimit,
  assertPaymentLinkListLimit,
  assertPaymentListLimit,
  assertSettlementListLimit,
  assertSubscriptionListLimit,
  assertWebhookDeliveryListLimit,
  assertWebhookEndpointListLimit,
  assertWithdrawalListLimit,
} from './payment-service.js';
import { KybError, KybService, assertKybHistoryLimit } from './kyb-service.js';
import { PspModeError, PspModeService, assertPricingHistoryLimit } from './psp-mode.js';
import { MerchantStateError, MerchantStateService, assertMerchantStateHistoryLimit } from './merchant-state-service.js';
import {
  SubMerchantError,
  SubMerchantService,
  assertPermissionHistoryLimit,
  assertPermissionListLimit,
  assertSubMerchantListLimit,
} from './submerchants.js';
import { FraudReviewError, MemoryFraudReviewQueue, assertFraudReviewListLimit, defaultFraudReviewQueue } from './fraud/review-queue.js';
import { UserMoneyService } from './user-money-service.js';
import { MemoryMerchantWebhookStore, MerchantWebhookService } from './merchant-webhooks.js';
import { SubscriptionService } from './subscriptions/subscription-service.js';
import { RailRegistry } from './rails/registry.js';
import { createPayRouter } from './router.js';
import { createKybPspRouter } from './kyb-router.js';
import { createMerchantStateRouter } from './merchant-state-router.js';
import type { MerchantAccountControls } from './merchant-account-controls.js';
import { createSubMerchantRouter } from './submerchant-router.js';
import { createSubscriptionRouter } from './subscription-router.js';
import { scriptedSql, type SqlCall } from './scripted-sql.testkit.js';

/**
 * List/history page size is refuse-closed when unset (tRPC + REST).
 *
 * Omit used to invent a 50-row (or 100-row) page. Blank must refuse.
 * Owner/client may pass 50 / 100 explicitly.
 */

function refusePay(fn: (n: number | undefined) => number, code: string) {
  expect(() => fn(undefined)).toThrow(PayError);
  expect(() => fn(Number.NaN)).toThrow(PayError);
  expect(() => fn(0)).toThrow(PayError);
  try {
    fn(undefined);
    throw new Error('expected refuse');
  } catch (e) {
    expect(e).toBeInstanceOf(PayError);
    expect((e as PayError).code).toBe(code);
    expect((e as PayError).message).not.toMatch(/default 50|50-row/i);
  }
}

describe('svc-pay list/history limit unset refuse', () => {
  it('payment/settlement/withdrawal asserts refuse blank / NaN / 0 — never invent 50', () => {
    refusePay(assertPaymentListLimit, 'pay.payment_list_limit_unset');
    refusePay(assertPaymentHistoryLimit, 'pay.payment_history_limit_unset');
    refusePay(assertPaymentLinkListLimit, 'pay.payment_link_list_limit_unset');
    refusePay(assertSettlementListLimit, 'pay.settlement_list_limit_unset');
    refusePay(assertWithdrawalListLimit, 'pay.withdrawal_list_limit_unset');
    expect(() => assertPaymentHistoryLimit(null as never)).toThrow(PayError);
    expect(() => assertPaymentHistoryLimit(-1)).toThrow(PayError);
    expect(() => assertPaymentHistoryLimit('50' as never)).toThrow(PayError);
    try {
      assertPaymentHistoryLimit(-3);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).code).toBe('pay.payment_history_limit_unset');
    }
  });

  it('webhook/subscription list asserts refuse blank / NaN / 0 — never invent 50', () => {
    refusePay(assertWebhookDeliveryListLimit, 'pay.webhook_delivery_list_limit_unset');
    refusePay(assertWebhookEndpointListLimit, 'pay.webhook_endpoint_list_limit_unset');
    refusePay(assertMandateListLimit, 'pay.subscription_mandate_list_limit_unset');
    refusePay(assertSubscriptionListLimit, 'pay.subscription_list_limit_unset');
    refusePay(assertExecutionListLimit, 'pay.subscription_execution_list_limit_unset');
    refusePay(assertCycleListLimit, 'pay.subscription_cycle_list_limit_unset');
  });

  it('runDueSubscriptions worker batch refuses blank / NaN — never invent 50; owner may pass 50', () => {
    refusePay(assertDueSubscriptionsBatchLimit, 'pay.due_subscriptions_batch_limit_unset');
    expect(assertDueSubscriptionsBatchLimit(50)).toBe(50);
    expect(assertDueSubscriptionsBatchLimit(1)).toBe(1);
    expect(assertDueSubscriptionsBatchLimit(500)).toBe(500);
    expect(() => assertDueSubscriptionsBatchLimit(0)).toThrow(PayError);
    expect(() => assertDueSubscriptionsBatchLimit(501)).toThrow(PayError);
    try {
      assertDueSubscriptionsBatchLimit(10_000);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).code).toBe('pay.validation_failed');
    }
  });

  it('processDue worker batch refuses blank / NaN — never invent 25; owner may pass 25', () => {
    refusePay(assertDueWebhookDeliveriesBatchLimit, 'pay.due_webhook_deliveries_batch_limit_unset');
    expect(assertDueWebhookDeliveriesBatchLimit(25)).toBe(25);
    expect(assertDueWebhookDeliveriesBatchLimit(1)).toBe(1);
    expect(assertDueWebhookDeliveriesBatchLimit(500)).toBe(500);
    expect(() => assertDueWebhookDeliveriesBatchLimit(0)).toThrow(PayError);
    expect(() => assertDueWebhookDeliveriesBatchLimit(501)).toThrow(PayError);
    try {
      assertDueWebhookDeliveriesBatchLimit(10_000);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).code).toBe('pay.validation_failed');
    }
    try {
      assertDueWebhookDeliveriesBatchLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).message).not.toMatch(/default 25|25-row/i);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertPaymentListLimit(50)).toBe(50);
    expect(assertPaymentLinkListLimit(50)).toBe(50);
    expect(assertSettlementListLimit(50)).toBe(50);
    expect(assertWithdrawalListLimit(50)).toBe(50);
    expect(assertWebhookDeliveryListLimit(50)).toBe(50);
    expect(assertWebhookEndpointListLimit(50)).toBe(50);
    expect(assertWebhookEndpointListLimit(201)).toBe(200);
    expect(assertMandateListLimit(50)).toBe(50);
    expect(assertSubscriptionListLimit(50)).toBe(50);
    expect(assertExecutionListLimit(50)).toBe(50);
    expect(assertCycleListLimit(50)).toBe(50);
    expect(assertCycleListLimit(1)).toBe(1);
    expect(assertCycleListLimit(201)).toBe(200);
    expect(assertPaymentListLimit(1)).toBe(1);
    expect(assertPaymentListLimit(200)).toBe(200);
    expect(assertPaymentListLimit(201)).toBe(200);
    expect(assertPaymentLinkListLimit(201)).toBe(200);
    expect(assertPaymentHistoryLimit(50)).toBe(50);
    expect(assertPaymentHistoryLimit(1)).toBe(1);
    expect(assertPaymentHistoryLimit(200)).toBe(200);
    expect(assertPaymentHistoryLimit(201)).toBe(200);
  });

  it('kyb/psp/merchantState/permission history refuse blank — never invent 50', () => {
    expect(() => assertKybHistoryLimit(undefined)).toThrow(KybError);
    expect(() => assertPricingHistoryLimit(undefined)).toThrow(PspModeError);
    expect(() => assertMerchantStateHistoryLimit(undefined)).toThrow(MerchantStateError);
    expect(() => assertPermissionHistoryLimit(undefined)).toThrow(SubMerchantError);
    expect(() => assertKybHistoryLimit(0)).toThrow(KybError);
    try {
      assertKybHistoryLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as KybError).code).toBe('pay.kyb_history_limit_unset');
    }
    try {
      assertPricingHistoryLimit(Number.NaN);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as PspModeError).code).toBe('pay.psp_pricing_history_limit_unset');
    }
    try {
      assertMerchantStateHistoryLimit(0);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as MerchantStateError).code).toBe('pay.merchant_state_history_limit_unset');
    }
    try {
      assertPermissionHistoryLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as SubMerchantError).code).toBe('pay.submerchant_permission_history_limit_unset');
    }
    expect(() => assertFraudReviewListLimit(undefined)).toThrow(FraudReviewError);
    expect(() => assertFraudReviewListLimit(0)).toThrow(FraudReviewError);
    try {
      assertFraudReviewListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as FraudReviewError).code).toBe('pay.fraud_review_list_limit_unset');
      expect((e as FraudReviewError).message).not.toMatch(/default 50|50-row/i);
    }
    expect(assertFraudReviewListLimit(50)).toBe(50);
    expect(assertFraudReviewListLimit(201)).toBe(200);
  });

  it('submerchant.list refuses blank — never invent 100; owner may pass 100', () => {
    expect(() => assertSubMerchantListLimit(undefined)).toThrow(SubMerchantError);
    expect(() => assertSubMerchantListLimit(0)).toThrow(SubMerchantError);
    try {
      assertSubMerchantListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as SubMerchantError).code).toBe('pay.submerchant_list_limit_unset');
      expect((e as SubMerchantError).message).not.toMatch(/default 100|100-row/i);
    }
    expect(assertSubMerchantListLimit(100)).toBe(100);
    expect(assertSubMerchantListLimit(1)).toBe(1);
    expect(assertSubMerchantListLimit(500)).toBe(500);
    expect(assertSubMerchantListLimit(501)).toBe(500);
  });

  it('submerchantPermission.list refuses blank — never invent 50; owner may pass 50', () => {
    expect(() => assertPermissionListLimit(undefined)).toThrow(SubMerchantError);
    expect(() => assertPermissionListLimit(0)).toThrow(SubMerchantError);
    try {
      assertPermissionListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as SubMerchantError).code).toBe('pay.submerchant_permission_list_limit_unset');
      expect((e as SubMerchantError).message).not.toMatch(/default 50|50-row/i);
    }
    expect(assertPermissionListLimit(50)).toBe(50);
    expect(assertPermissionListLimit(1)).toBe(1);
    expect(assertPermissionListLimit(201)).toBe(200);
  });

  it('listWithdrawals refuses without limit — never invents 50', async () => {
    const money = new UserMoneyService({} as never, {} as never, {} as never, { operatorCreditRails: [] });
    await expect(money.listWithdrawals('user')).rejects.toMatchObject({
      code: 'pay.withdrawal_list_limit_unset',
    });
    expect(assertWithdrawalListLimit(50)).toBe(50);
  });

  it('services refuse an omitted page size before reading, and send a given one to the query', async () => {
    const MERCHANT = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const merchantRow = {
      id: MERCHANT,
      user_id: 'merchant-user',
      mode: 'gateway',
      tier: 1,
      kyb_status: 'approved',
      kyb_ref: null,
      status: 'active',
      pricing: { feeBps: 100 },
      settlement_prefs: {},
    };
    const subscriptionRow = {
      id: '44444444-4444-4444-8444-444444444444',
      mandate_id: '55555555-5555-4555-8555-555555555555',
      merchant_id: MERCHANT,
      customer_id: 'customer-1',
      next_run_at: new Date(),
      status: 'active',
      cancelled_at: null,
      path: 'crypto_invoice',
      created_at: new Date(),
      anchor_at: new Date(),
      anchor_occurrence: 0,
      paused_at: null,
      resumed_at: null,
      stalled_at: null,
      stall_reason: null,
      price_id: null,
    };
    const db = () =>
      scriptedSql<Sql>((call) =>
        call.text.includes('FROM pay.merchants')
          ? [merchantRow]
          : call.text.includes('FROM pay.subscriptions WHERE id')
            ? [subscriptionRow]
            : [],
      );
    /** The page size the service sent: the value bound right after `LIMIT`. */
    const sentLimit = (calls: readonly SqlCall[]): unknown => {
      for (const call of calls) {
        const at = call.text.split('$?').findIndex((part) => /LIMIT\s*$/.test(part));
        if (at >= 0) return call.values[at];
      }
      return undefined;
    };
    const omitted = async (run: (sql: Sql) => Promise<unknown>, code: string) => {
      const { sql, calls } = db();
      await expect(run(sql)).rejects.toMatchObject({ code });
      expect(sentLimit(calls), `${code}: nothing paged`).toBeUndefined();
    };
    const given = async (run: (sql: Sql) => Promise<unknown>, expected: number) => {
      const { sql, calls } = db();
      // Only what was asked of the database matters here; a page built from no rows may still refuse after it.
      await run(sql).catch(() => undefined);
      expect(sentLimit(calls)).toBe(expected);
    };
    const ledger = {} as LedgerClient;
    const rails = new RailRegistry([]);
    const pay = (sql: Sql) => new PayService(sql, ledger, rails);

    await omitted((sql) => pay(sql).listPayments({ merchantId: MERCHANT }), 'pay.payment_list_limit_unset');
    await given((sql) => pay(sql).listPayments({ merchantId: MERCHANT, limit: 7 }), 8);
    await omitted((sql) => pay(sql).history(MERCHANT), 'pay.payment_history_limit_unset');
    await given((sql) => pay(sql).history(MERCHANT, 7), 7);
    await omitted((sql) => pay(sql).listPaymentLinks(MERCHANT, {}), 'pay.payment_link_list_limit_unset');
    await given((sql) => pay(sql).listPaymentLinks(MERCHANT, { limit: 7 }), 8);
    await omitted((sql) => pay(sql).listSettlements({ merchantId: MERCHANT }), 'pay.settlement_list_limit_unset');
    await given((sql) => pay(sql).listSettlements({ merchantId: MERCHANT, limit: 7 }), 8);

    const money = (sql: Sql) => new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] });
    await omitted((sql) => money(sql).listWithdrawals('user'), 'pay.withdrawal_list_limit_unset');
    await given((sql) => money(sql).listWithdrawals('user', 7), 7);

    await omitted((sql) => new KybService(sql).history(MERCHANT), 'pay.kyb_history_limit_unset');
    await given((sql) => new KybService(sql).history(MERCHANT, 7), 7);
    await omitted((sql) => new PspModeService(sql).pricingHistory(MERCHANT), 'pay.psp_pricing_history_limit_unset');
    await given((sql) => new PspModeService(sql).pricingHistory(MERCHANT, 7), 7);
    await omitted((sql) => new MerchantStateService(sql).history(MERCHANT), 'pay.merchant_state_history_limit_unset');
    await given((sql) => new MerchantStateService(sql).history(MERCHANT, 7), 7);

    // The subtree reads refuse a blank page before they look at the tree at all.
    await omitted((sql) => new SubMerchantService(sql).listSubMerchants(MERCHANT, OTHER), 'pay.submerchant_list_limit_unset');
    await omitted((sql) => new SubMerchantService(sql).listPermissions(MERCHANT, OTHER), 'pay.submerchant_permission_list_limit_unset');
    await omitted(
      (sql) => new SubMerchantService(sql).permissionHistory(MERCHANT, OTHER),
      'pay.submerchant_permission_history_limit_unset',
    );

    const subs = (sql: Sql) => new SubscriptionService(sql);
    await omitted((sql) => subs(sql).listMandates(MERCHANT), 'pay.subscription_mandate_list_limit_unset');
    await given((sql) => subs(sql).listMandates(MERCHANT, { limit: 7 }), 8);
    await omitted((sql) => subs(sql).listSubscriptions(MERCHANT), 'pay.subscription_list_limit_unset');
    await given((sql) => subs(sql).listSubscriptions(MERCHANT, { limit: 7 }), 8);
    await omitted((sql) => subs(sql).listCycles(MERCHANT), 'pay.subscription_cycle_list_limit_unset');
    await given((sql) => subs(sql).listCycles(MERCHANT, { limit: 7 }), 7);
    await omitted((sql) => subs(sql).listExecutions(subscriptionRow.id), 'pay.subscription_execution_list_limit_unset');
    await given((sql) => subs(sql).listExecutions(subscriptionRow.id, { limit: 7 }), 7);
    await omitted((sql) => subs(sql).runDueSubscriptions(), 'pay.due_subscriptions_batch_limit_unset');
    await given((sql) => subs(sql).runDueSubscriptions({ limit: 7 }), 7);

    // The fraud queue and the webhook store page in memory: the omitted page refuses, a given one is what is asked for.
    expect(() => new MemoryFraudReviewQueue().listOpen(MERCHANT)).toThrow(
      expect.objectContaining({ code: 'pay.fraud_review_list_limit_unset' }),
    );
    const store = new MemoryMerchantWebhookStore();
    const seen: Array<{ method: string; limit: unknown }> = [];
    const watched = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const opts = args[1] as { limit?: unknown } | undefined;
          if (prop === 'claimDue') seen.push({ method: 'claimDue', limit: args[0] });
          else if (opts && typeof opts === 'object' && 'limit' in opts) seen.push({ method: String(prop), limit: opts.limit });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const hooks = new MerchantWebhookService(watched, { retryScheduleSeconds: [60] });
    await expect(hooks.listEndpoints(MERCHANT)).rejects.toMatchObject({ code: 'pay.webhook_endpoint_list_limit_unset' });
    await expect(hooks.listDeliveries(MERCHANT)).rejects.toMatchObject({ code: 'pay.webhook_delivery_list_limit_unset' });
    await expect(hooks.processDue()).rejects.toMatchObject({ code: 'pay.due_webhook_deliveries_batch_limit_unset' });
    expect(seen).toEqual([]);
    await hooks.listEndpoints(MERCHANT, 7);
    await hooks.listDeliveries(MERCHANT, { limit: 7 });
    await hooks.processDue(7);
    expect(seen).toEqual([
      { method: 'listEndpoints', limit: 7 },
      { method: 'listDeliveries', limit: 7 },
      { method: 'claimDue', limit: 7 },
    ]);
  });

  it('routers pass an omitted page size on as omitted, so the service refuses it', async () => {
    const USER = '33333333-3333-4333-8333-333333333333';
    const MERCHANT = '11111111-1111-4111-8111-111111111111';
    const SUB = '44444444-4444-4444-8444-444444444444';
    const ctx = (scopes: string[]): Context => ({
      principal: {
        userId: USER,
        sub: USER,
        sid: '77777777-7777-4777-8777-777777777777',
        scopes,
        mfa: true,
        tier: 'full',
        expiresAt: new Date(Date.now() + 60_000),
      },
      service: null,
      region: 'DE',
      requestId: 'req-1',
    });
    const merchant = {
      id: MERCHANT,
      userId: USER,
      mode: 'gateway' as const,
      tier: 1,
      kybStatus: 'approved' as const,
      kybRef: null,
      status: 'active' as const,
      pricing: { feeBps: 100 },
      settlementPrefs: {},
    };
    /** The router's refusal carries the service's code, in its cause or its words. */
    const refusedWith = (code: string) => (err: unknown) => {
      const e = err as { message?: string; cause?: { code?: string } };
      return e.cause?.code === code || String(e.message).includes(code);
    };
    /** A stand-in that keeps what each method was asked, then answers as the real one does on a blank page. */
    function recording<T>(answers: Record<string, (...args: never[]) => unknown>) {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const service = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== 'string' || prop === 'then') return undefined;
            return (...args: unknown[]) => {
              calls.push({ method: prop, args });
              const answer = answers[prop];
              if (!answer) throw new Error(`stand-in has no ${prop}`);
              return answer(...(args as never[]));
            };
          },
        },
      ) as T;
      const argsOf = (method: string): unknown[] => {
        const call = calls.find((c) => c.method === method);
        expect(call, `${method} was called`).toBeDefined();
        return call!.args;
      };
      return { service, argsOf };
    }

    // svc-pay's own tRPC router: merchant.listLinks hands the input on without a page of its own.
    const pay = recording<PayService>({
      getMerchant: async () => merchant,
      listPaymentLinks: async (_m: string, query: { limit?: number }) => assertPaymentLinkListLimit(query.limit),
    });
    const payRouter = createPayRouter(pay.service, new RailRegistry([]), recording<UserMoneyService>({}).service);
    await expect(payRouter.createCaller(ctx(['pay:read'])).merchant.listLinks({ merchantId: MERCHANT })).rejects.toSatisfy(
      refusedWith('pay.payment_link_list_limit_unset'),
    );
    expect(pay.argsOf('listPaymentLinks')[1]).not.toHaveProperty('limit');
    // payment.history, withdrawal.mine and fraud.listOpenReviews hand an omitted page on as omitted too.
    const PAYMENT = '66666666-6666-4666-8666-666666666666';
    const reads = recording<PayService>({
      getMerchant: async () => merchant,
      getPayment: async () => ({ id: PAYMENT, merchantId: MERCHANT }),
      history: async (_p: string, limit?: number) => assertPaymentHistoryLimit(limit),
    });
    const money = recording<UserMoneyService>({
      listWithdrawals: async (_u: string, limit?: number) => assertWithdrawalListLimit(limit),
    });
    // With no database the router reads the in-process review queue.
    const listOpen = vi.spyOn(defaultFraudReviewQueue, 'listOpen');
    const readsRouter = createPayRouter(reads.service, new RailRegistry([]), money.service);
    await expect(readsRouter.createCaller(ctx(['pay:read'])).payment.history({ paymentId: PAYMENT })).rejects.toSatisfy(
      refusedWith('pay.payment_history_limit_unset'),
    );
    expect(reads.argsOf('history')).toEqual([PAYMENT, undefined]);
    await expect(readsRouter.createCaller(ctx(['trade:read'])).withdrawal.mine()).rejects.toSatisfy(
      refusedWith('pay.withdrawal_list_limit_unset'),
    );
    expect(money.argsOf('listWithdrawals')).toEqual([USER, undefined]);
    await expect(readsRouter.createCaller(ctx(['admin:treasury'])).fraud.listOpenReviews({})).rejects.toSatisfy(
      refusedWith('pay.fraud_review_list_limit_unset'),
    );
    expect(listOpen).toHaveBeenCalledWith(undefined, undefined);
    listOpen.mockRestore();
    // The records' inputs keep limit optional and undefaulted, so an omitted limit reaches the service's refusal.
    const noLimit = PAY_MERCHANT_LIST_LINKS.input.safeParse({ merchantId: MERCHANT });
    expect(noLimit.success && !('limit' in noLimit.data)).toBe(true);
    const omittedHistory = PAY_PAYMENT_HISTORY.input.safeParse({ paymentId: MERCHANT });
    expect(omittedHistory.success && !('limit' in omittedHistory.data)).toBe(true);

    // KYB and pricing history (operator reads).
    const kyb = recording<KybService>({ history: async (_m: string, limit?: number) => assertKybHistoryLimit(limit) });
    const psp = recording<PspModeService>({ pricingHistory: async (_m: string, limit?: number) => assertPricingHistoryLimit(limit) });
    const kybCaller = createKybPspRouter(kyb.service, psp.service).createCaller(ctx(['admin:read']));
    await expect(kybCaller.kyb.history({ merchantId: MERCHANT })).rejects.toSatisfy(refusedWith('pay.kyb_history_limit_unset'));
    expect(kyb.argsOf('history')).toEqual([MERCHANT, undefined]);
    await expect(kybCaller.psp.pricingHistory({ merchantId: MERCHANT })).rejects.toSatisfy(
      refusedWith('pay.psp_pricing_history_limit_unset'),
    );
    expect(psp.argsOf('pricingHistory')).toEqual([MERCHANT, undefined]);

    // Merchant state history: the shared input requires a limit and is never defaulted, so an omitted one is refused.
    expect(PAY_ACCOUNT_CONTROLS_HISTORY.input).toBe(accountControlHistoryInputSchema);
    expect(PAY_ACCOUNT_CONTROLS_HISTORY.input.safeParse({ target: { area: 'merchant', merchantId: MERCHANT } }).success).toBe(false);
    const controls = recording<MerchantAccountControls>({});
    const stateCaller = createMerchantStateRouter({} as MerchantStateService, controls.service).createCaller(ctx(['admin:read']));
    await expect(stateCaller.merchantState.history({ target: { area: 'merchant', merchantId: MERCHANT } } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    // PayFac subtree reads.
    const tree = recording<SubMerchantService>({
      listSubMerchants: async (_a: string, _m: string, limit?: number) => assertSubMerchantListLimit(limit),
      listPermissions: async (_a: string, _s: string, limit?: number) => assertPermissionListLimit(limit),
      permissionHistory: async (_a: string, _s: string, limit?: number) => assertPermissionHistoryLimit(limit),
    });
    const treeCaller = createSubMerchantRouter(tree.service, { getMerchantByUserId: async () => ({ id: MERCHANT }) }).createCaller(
      ctx(['pay:read']),
    );
    await expect(treeCaller.submerchant.list({ merchantId: MERCHANT })).rejects.toSatisfy(refusedWith('pay.submerchant_list_limit_unset'));
    expect(tree.argsOf('listSubMerchants')).toEqual([MERCHANT, MERCHANT, undefined]);
    await expect(treeCaller.submerchantPermission.list({ subjectMerchantId: MERCHANT })).rejects.toSatisfy(
      refusedWith('pay.submerchant_permission_list_limit_unset'),
    );
    expect(tree.argsOf('listPermissions')).toEqual([MERCHANT, MERCHANT, undefined]);
    await expect(treeCaller.submerchantPermission.history({ subjectMerchantId: MERCHANT })).rejects.toSatisfy(
      refusedWith('pay.submerchant_permission_history_limit_unset'),
    );
    expect(tree.argsOf('permissionHistory')).toEqual([MERCHANT, MERCHANT, undefined]);

    // Subscriptions: the fleet lists and the cycle journal.
    const subs = recording<SubscriptionService>({
      getSubscription: async () => ({ id: SUB, merchantId: MERCHANT }),
      listMandates: async (_m: string, o: { limit?: number }) => assertMandateListLimit(o.limit),
      listSubscriptions: async (_m: string, o: { limit?: number }) => assertSubscriptionListLimit(o.limit),
      listExecutions: async (_s: string, o: { limit?: number }) => assertExecutionListLimit(o.limit),
      listCycles: async (_s: string, o: { limit?: number }) => assertCycleListLimit(o.limit),
    });
    const subCaller = createSubscriptionRouter(subs.service, pay.service).createCaller(ctx(['pay:read']));
    await expect(subCaller.mandate.list({ merchantId: MERCHANT })).rejects.toSatisfy(
      refusedWith('pay.subscription_mandate_list_limit_unset'),
    );
    expect(subs.argsOf('listMandates')[1]).toMatchObject({ limit: undefined });
    await expect(subCaller.subscription.list({ merchantId: MERCHANT })).rejects.toSatisfy(refusedWith('pay.subscription_list_limit_unset'));
    expect(subs.argsOf('listSubscriptions')[1]).toMatchObject({ limit: undefined });
    await expect(subCaller.subscription.listExecutions({ subscriptionId: SUB })).rejects.toSatisfy(
      refusedWith('pay.subscription_execution_list_limit_unset'),
    );
    expect(subs.argsOf('listExecutions')[1]).toEqual({ limit: undefined });
    await expect(subCaller.subscription.cycles({ subscriptionId: SUB })).rejects.toSatisfy(
      refusedWith('pay.subscription_cycle_list_limit_unset'),
    );
    expect(subs.argsOf('listCycles')[1]).toEqual({ limit: undefined });
  });
});
