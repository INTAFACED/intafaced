import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { partial } from '@intafaced/service-kit/testing';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { stubApprovalConsumer } from './action-approval-consume.js';
import {
  postDisputeOpening,
  postDisputeShortfall,
  postDisputeShortfallRecovered,
  postDisputeWon,
  type ChargebackPostInput,
  type ChargebackShortfallPostInput,
} from './chargeback-ledger.js';
import {
  CHARGEBACK_LEDGER_REFUSE_CODE,
  CHARGEBACK_LEDGER_SOCKET_ID,
  CHARGEBACK_LEDGER_UNCOVERED_CODE,
  refuseChargebackLedgerPost,
  refuseChargebackUncovered,
} from './fraud/chargeback-ledger-socket.js';
import { MemoryDisputeCaseStore } from './fraud/dispute-case.js';
import { grantedOwnerPayScopes, issueMerchantPayScopesViaGrantPath } from './merchant-pay-grant-path.js';
import type { PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { RailRegistry } from './rails/registry.js';
import { MemoryRestIdempotencyStore } from './rest-idempotency.js';
import { createPayRouter } from './router.js';
import type { UserMoneyService } from './user-money-service.js';

/**
 * Q-pay — chargeback post-or-refuse.
 *
 * HTTP must post via ledger-client (`chargeback-ledger.ts`) or return a named
 * refuse. It must not claim `posted` without a tx id. Won, shortfall, and
 * recovery are posted from that file. bank-payout stays absent. No Hyperswitch.
 * No `pay:*` grants.
 *
 * The webhook door (`dispute.opened`) books the same opening or records the named refusal: payment-service.test.ts
 * ("turns an insufficient-funds post on the webhook door into the named uncovered refusal") and
 * payment-service/chargeback-custody.test.ts drive it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = readFileSync(join(here, '../package.json'), 'utf8');

const MERCHANT = '55555555-5555-4555-8555-555555555555';
const MERCHANT_USER = '44444444-4444-4444-8444-444444444444';
const PAYMENT = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const CONFIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function ctx(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: '88888888-8888-4888-8888-888888888888', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'chargeback-unwired' };
}

describe('chargeback ledger wire — post-or-refuse (Q-pay)', () => {
  it('each dispute post is exactly its ledger-client recipe', async () => {
    const ledger = new MemoryLedger();
    const posts: PostRequest[] = [];
    const realPost = ledger.post.bind(ledger);
    ledger.post = async (request: PostRequest) => {
      posts.push(request);
      return realPost(request);
    };
    await realPost(
      recipes.paymentCapture({
        paymentId: PAYMENT,
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        railRef: `ch_${PAYMENT}`,
      }),
    );
    const open: ChargebackPostInput = {
      disputeId: 'dsp-recipe',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      rail: 'card-sandbox',
      fromClearing: amt('30'),
      fromMerchantBalance: amt('0'),
    };
    const shortfall: ChargebackShortfallPostInput = {
      disputeId: 'dsp-recipe',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      assetId: 'USDT',
      rail: 'card-sandbox',
      amount: amt('10'),
    };
    // A post the book refuses for funds still went to the ledger as the recipe: what was asked is what is checked.
    const steps: Array<[() => Promise<unknown>, PostRequest]> = [
      [() => postDisputeOpening(ledger, open), recipes.chargebackOpen(open)],
      [() => postDisputeShortfall(ledger, shortfall), recipes.chargebackShortfall(shortfall)],
      [() => postDisputeShortfallRecovered(ledger, shortfall), recipes.chargebackShortfallRecovered(shortfall)],
      [() => postDisputeWon(ledger, open), recipes.chargebackWon(open)],
    ];
    for (const [post, recipe] of steps) {
      const before = posts.length;
      await post().catch(() => undefined);
      expect(posts.slice(before)).toEqual([recipe]);
    }
  });

  it('the router dispute door posts through the service or names the refusal; a blank tx id is never posted', async () => {
    const open = async (openChargeback?: () => Promise<{ txId: string }>) => {
      const pay = partial<PayService>({
        getMerchant: async () => partial<Awaited<ReturnType<PayService['getMerchant']>>>({ id: MERCHANT, userId: USER }),
        ...(openChargeback
          ? { openChargeback: async () => partial<Awaited<ReturnType<PayService['openChargeback']>>>(await openChargeback()) }
          : {}),
      });
      const router = createPayRouter(
        pay,
        new RailRegistry([]),
        {} as UserMoneyService,
        null,
        undefined,
        stubApprovalConsumer(CONFIRM),
        null,
        new MemoryDisputeCaseStore(),
      );
      return (await router.createCaller(await ctx(['admin:treasury']))).fraud.openDispute({
        disputeId: `dsp-${randomUUID()}`,
        paymentId: PAYMENT,
        merchantId: MERCHANT,
        amount: '40',
        assetId: 'USDT',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      });
    };
    await expect(open()).resolves.toMatchObject({
      ledgerWire: 'refused',
      ledgerTxId: null,
      ledgerRefuseCode: CHARGEBACK_LEDGER_REFUSE_CODE,
      ledgerSocket: CHARGEBACK_LEDGER_SOCKET_ID,
    });
    const blank = await open(async () => ({ txId: '   ' }));
    expect(blank.ledgerWire).not.toBe('posted');
    expect(blank.ledgerTxId).toBeNull();
    await expect(open(async () => ({ txId: 'tx-opening-1' }))).resolves.toMatchObject({ ledgerWire: 'posted', ledgerTxId: 'tx-opening-1' });
  });

  it('named socket still refuses fixture and uncovered covers', () => {
    const ref = { disputeId: 'dsp-1', paymentId: PAYMENT };
    expect(refuseChargebackLedgerPost(ref)).toMatchObject({
      code: CHARGEBACK_LEDGER_REFUSE_CODE,
      socket: CHARGEBACK_LEDGER_SOCKET_ID,
      ...ref,
    });
    expect(refuseChargebackUncovered(ref)).toMatchObject({
      code: CHARGEBACK_LEDGER_UNCOVERED_CODE,
      socket: CHARGEBACK_LEDGER_SOCKET_ID,
      ...ref,
    });
    expect(CHARGEBACK_LEDGER_REFUSE_CODE).toBe('pay.chargeback_ledger_unwired');
    expect(CHARGEBACK_LEDGER_UNCOVERED_CODE).toBe('pay.chargeback_uncovered');
    expect(CHARGEBACK_LEDGER_SOCKET_ID).toBe('socket.pay-chargeback-ledger-wire');
  });

  it('merchant REST has no reverse-money dispute door', async () => {
    const app = Fastify({ logger: false });
    const mounted: string[] = [];
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) mounted.push(`${method} ${route.url}`);
    });
    await registerPublicPayRest(app, {
      edgeSecret: 'a-pay-public-rest-edge-secret-long-enough-x',
      serviceName: 'svc-pay',
      pay: new Proxy({} as PayService, { get: () => async () => undefined }),
      idempotency: new MemoryRestIdempotencyStore(),
    });
    await app.ready();
    await app.close();
    expect(mounted).toContain('POST /v1/payments/:id/refund');
    expect(mounted.filter((route) => /dispute|chargeback/i.test(route))).toEqual([]);
  });

  it('bank-payout door stays absent and refuses', async () => {
    const bank = new BankPayoutAbsentAdapter();
    expect(bank.id).toBe('bank-payout');
    expect(bank.mode).toBe('absent');
    expect(bank.health().healthy).toBe(false);
    const result = await bank.payout({ settlementId: 'stl-1', merchantId: MERCHANT, amount: amt('10'), assetId: 'USDT' } as never);
    expect(result).toMatchObject({ ok: false, status: 'failed', failureCode: 'bank.not_configured', railRef: '' });
  });

  it('does not adopt Hyperswitch or invent pay:* grants', () => {
    expect(pkg).not.toMatch(/hyperswitch/i);
    // The grant path asks the published law and never names a grantor of its own: no KYB, no scopes.
    const owner = { id: MERCHANT, userId: MERCHANT_USER, kybStatus: 'approved' as const, status: 'active' as const };
    expect(grantedOwnerPayScopes(owner, MERCHANT_USER).scopes).toEqual(['pay:read', 'pay:write']);
    expect(grantedOwnerPayScopes({ ...owner, kybStatus: 'pending' }, MERCHANT_USER).scopes).toEqual([]);
    expect(grantedOwnerPayScopes(owner, USER)).toEqual({ merchantId: null, scopes: [] });
    expect(() =>
      issueMerchantPayScopesViaGrantPath({
        merchantId: MERCHANT,
        ownedMerchantId: MERCHANT,
        scopes: ['pay:read'],
        kybStatus: 'pending',
        merchantStatus: 'active',
        actorUserId: MERCHANT_USER,
        ownerUserId: MERCHANT_USER,
        role: 'owner',
      }),
    ).toThrow();
  });
});
