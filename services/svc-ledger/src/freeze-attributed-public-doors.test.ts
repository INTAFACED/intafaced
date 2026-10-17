import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { serviceAuthHeadersForBody, type Context } from '@intafaced/contracts';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  orderHoldAccount,
  parseAmount as amt,
  recipes,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPostingFreeze, frozenMessage } from './ledger/freeze.js';
import { registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import { createLedgerRouter } from './router.js';
import { registerS2sHttp } from './s2s-http.js';
import { registerLedgerStatusHttp } from './status-http.js';
import type { LedgerService } from './service.js';

/**
 * D26-P2-01c deepen — freeze_attributed + /ready + tRPC freeze vs S2S post.
 *
 * `promise-falsify-public-doors.test.ts` already proves operator freeze stops
 * `/trpc/post` and that purpose survives `/trpc/balances`. That suite's in-memory
 * freeze OVERWROTE a second reason. Production `writeFreeze` refuses that
 * (`ledger.freeze_attributed`). `/ready` lived only in `index.ts`, so a freeze
 * that still advertised ready could not fail a unit. tRPC `freeze` was proven
 * against a stub, never against the mounted S2S post door on the same ledger.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SERVICE_SECRET = 'freeze-attributed-ledger-service-secret';
const TOKENS = {
  secret: 'freeze-attributed-ledger-operator-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

class AttributedPublicDoorLedger {
  readonly engine = new MemoryLedger();
  private readonly freezeSwitch = new MemoryPostingFreeze();

  async post(request: PostRequest) {
    const existing = await this.engine.getTxByKey(request.idempotencyKey);
    if (existing) return existing;
    const state = this.freezeSwitch.snapshot();
    if (state.frozen) {
      throw new LedgerError(frozenMessage(state.reason), 'ledger.frozen');
    }
    return this.engine.post(request);
  }

  balance = this.engine.balance.bind(this.engine);
  balances = this.engine.balances.bind(this.engine);
  getTx = this.engine.getTx.bind(this.engine);
  getTxByKey = this.engine.getTxByKey.bind(this.engine);

  async freeze(reason: string, actor: string) {
    return this.freezeSwitch.freeze(reason, actor);
  }

  async unfreeze(actor: string, confirmOperatorId?: string | null) {
    return this.freezeSwitch.unfreeze(actor, confirmOperatorId ?? null);
  }

  async freezeState() {
    return this.freezeSwitch.snapshot();
  }

  async status() {
    const state = this.freezeSwitch.snapshot();
    return { postingEnabled: !state.frozen, frozenReason: state.reason, frozenBy: state.actor };
  }
}

function wirePost(request: PostRequest): string {
  return JSON.stringify({
    ...request,
    entries: request.entries.map((entry) => ({
      account: entry.account,
      direction: entry.direction,
      amount: formatAmount(entry.amount),
    })),
  });
}

describe('mounted freeze attribution — svc-ledger (D26-P2-01c)', () => {
  let app: FastifyInstance;
  let ledger: AttributedPublicDoorLedger;

  beforeEach(async () => {
    ledger = new AttributedPublicDoorLedger();
    app = Fastify({ logger: false });
    registerLedgerStatusHttp(app, ledger, 'svc-ledger');
    registerS2sHttp(app, ledger as unknown as LedgerService, SERVICE_SECRET, { bodyBind: 'require' });
    registerOperatorHttp(app, ledger as unknown as LedgerService, TOKENS, stubApprovalConsumer(CONFIRM));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function servicePost(request: PostRequest) {
    const payload = wirePost(request);
    return app.inject({
      method: 'POST',
      url: '/trpc/post',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
  }

  async function serviceBalance(body: unknown) {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/trpc/balance',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
  }

  async function operatorBearer(userId = OPERATOR): Promise<string> {
    const { token } = await issueAccessToken(
      {
        userId,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        scopes: ['admin:treasury'],
        tier: 'basic',
        mfa: true,
      },
      TOKENS,
    );
    return `Bearer ${token}`;
  }

  async function trpcOperatorCtx(): Promise<Context> {
    const { token } = await issueAccessToken(
      {
        userId: OPERATOR,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        scopes: ['admin:treasury'],
        tier: 'basic',
        mfa: true,
      },
      TOKENS,
    );
    return {
      principal: await verifyAccessToken(token, TOKENS),
      service: null,
      region: 'DE',
      requestId: 'req-trpc-freeze',
    };
  }

  const deposit = (railRef: string, amount = '5') =>
    recipes.deposit({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'test',
      railRef,
    });

  it('tRPC freeze stops the mounted S2S post door and takes /ready out of rotation', async () => {
    expect((await servicePost(deposit('before-trpc-freeze'))).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);

    const caller = createLedgerRouter(ledger as unknown as LedgerService, undefined, stubApprovalConsumer(CONFIRM)).createCaller(
      await trpcOperatorCtx(),
    );
    await expect(
      caller.freeze({ reason: 'tRPC freeze must halt S2S post', approvalId: 'appr-1', operationId: 'op-1' }),
    ).resolves.toMatchObject({
      postingEnabled: false,
      frozenReason: 'tRPC freeze must halt S2S post',
      frozenBy: OPERATOR,
      confirmOperatorId: CONFIRM,
    });

    const blocked = await servicePost(deposit('while-trpc-frozen', '9'));
    expect(blocked.statusCode).toBe(412);
    expect(blocked.json()).toMatchObject({ code: 'ledger.frozen' });

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false, reason: 'tRPC freeze must halt S2S post' });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, postingEnabled: false });
  });

  it('second operator freeze is 409 freeze_attributed — first reason stands, post stays frozen', async () => {
    const authorization = await operatorBearer();
    const first = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization },
      payload: { reason: 'operator halt for USDT recon', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ frozen: true, reason: 'operator halt for USDT recon', actor: OPERATOR });

    const otherAuth = await operatorBearer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const second = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: otherAuth },
      payload: { reason: 'different actor trying to clobber', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'ledger.freeze_attributed' });

    const standing = await app.inject({
      method: 'GET',
      url: '/operator/freeze',
      headers: { authorization },
    });
    expect(standing.json()).toMatchObject({
      frozen: true,
      reason: 'operator halt for USDT recon',
      actor: OPERATOR,
    });

    const blocked = await servicePost(deposit('clobber-must-not-open', '3'));
    expect(blocked.statusCode).toBe(412);
    expect(blocked.json()).toMatchObject({ code: 'ledger.frozen' });

    const same = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization },
      payload: { reason: 'operator halt for USDT recon', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ frozen: true, reason: 'operator halt for USDT recon', actor: OPERATOR });
  });

  it('operator unfreeze restores /ready and the mounted post door', async () => {
    const authorization = await operatorBearer();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/freeze',
          headers: { authorization },
          payload: { reason: 'temporary halt then thaw', approvalId: 'appr-1', operationId: 'op-1' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await servicePost(deposit('frozen-window', '2'))).statusCode).toBe(412);

    const thawed = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers: { authorization },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(thawed.statusCode).toBe(200);
    expect(thawed.json()).toMatchObject({ frozen: false, reason: null, actor: OPERATOR });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect((await servicePost(deposit('after-thaw', '2'))).statusCode).toBe(200);
  });

  it('singular balance door canonicalises purpose so padded claims cannot split a pot on the wire', async () => {
    expect((await servicePost(deposit('purpose-seed', '10'))).statusCode).toBe(200);
    expect(
      (
        await servicePost(
          recipes.orderHold({
            orderId: 'door-purpose-1',
            userId: USER,
            assetId: 'USDT',
            amount: amt('4'),
          }),
        )
      ).statusCode,
    ).toBe(200);

    const padded = await serviceBalance({
      ...orderHoldAccount(USER, 'USDT', 'door-purpose-1'),
      purpose: '  order:door-purpose-1  ',
    });
    expect(padded.statusCode).toBe(200);
    expect(padded.json()).toMatchObject({ kind: 'hold', purpose: 'order:door-purpose-1', amount: '4' });

    const available = await serviceBalance(userAvailable(USER, 'USDT'));
    expect(available.json()).toMatchObject({ kind: 'available', purpose: '', amount: '6' });
  });
});
