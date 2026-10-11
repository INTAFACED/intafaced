import { issueAccessToken } from '@intafaced/auth';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  loanCollateralAccount,
  loanReserve,
  orderHoldAccount,
  parseAmount as amt,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type PostRequest,
} from '@intafaced/ledger-client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import { RECIPE_REQUIRED_CODE } from './recipe-gate.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

/**
 * D26-P2-01c — PROMISE-FALSIFY THE DOORS, NOT THE PURE FUNCTIONS.
 *
 * Every recipe below enters through the mounted, body-bound S2S HTTP route and
 * every observation leaves through the mounted balance routes. The operator
 * freeze crosses its separately-authenticated HTTP door and must stop the same
 * posting door. Removing a recipe from the public package export, dropping
 * purpose from the wire, mounting the wrong route, or softening a freeze makes
 * this named suite fail while recipe-only tests could remain green.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SERVICE_SECRET = 'promise-falsify-ledger-service-secret';
const TOKENS = {
  secret: 'promise-falsify-ledger-operator-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

type FreezeState = {
  frozen: boolean;
  reason: string | null;
  actor: string | null;
  changedAt: Date;
  changedAtPrecise: string;
};

/**
 * Real ledger-client reference engine with only the database-owned freeze row
 * replaced. Post, account identity, idempotency, balancing, and recipes remain
 * production code; a unit test must not need Postgres to prove mounted routes.
 */
class PublicDoorLedger {
  readonly engine = new MemoryLedger();
  private state: FreezeState = this.snapshot(false, null, null);

  async post(request: PostRequest) {
    const existing = await this.engine.getTxByKey(request.idempotencyKey);
    if (existing) return existing;
    if (this.state.frozen) {
      throw new LedgerError(`Ledger posting is frozen: ${this.state.reason ?? 'operator freeze'}`, 'ledger.frozen');
    }
    return this.engine.post(request);
  }

  balance = this.engine.balance.bind(this.engine);
  balances = this.engine.balances.bind(this.engine);
  getTx = this.engine.getTx.bind(this.engine);
  getTxByKey = this.engine.getTxByKey.bind(this.engine);

  async freeze(reason: string, actor: string): Promise<FreezeState> {
    this.state = this.snapshot(true, reason, actor);
    return this.state;
  }

  async unfreeze(actor: string): Promise<FreezeState> {
    this.state = this.snapshot(false, null, actor);
    return this.state;
  }

  async freezeState(): Promise<FreezeState> {
    return this.state;
  }

  private snapshot(frozen: boolean, reason: string | null, actor: string | null): FreezeState {
    const changedAt = new Date();
    return { frozen, reason, actor, changedAt, changedAtPrecise: changedAt.toISOString() };
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

describe('promise-falsify public doors — svc-ledger + ledger-client (D26-P2-01c)', () => {
  let app: FastifyInstance;
  let ledger: PublicDoorLedger;

  beforeEach(async () => {
    ledger = new PublicDoorLedger();
    app = Fastify({ logger: false });
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

  async function serviceRead(path: '/trpc/balance' | '/trpc/balances', body: unknown) {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
  }

  async function operatorBearer(): Promise<string> {
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
    return `Bearer ${token}`;
  }

  it('keeps order and withdrawal recipe pots separate across post and balances doors', async () => {
    expect(
      (
        await servicePost(
          recipes.deposit({
            userId: USER,
            assetId: 'USDT',
            amount: amt('30'),
            rail: 'test',
            railRef: 'purpose-seed',
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await servicePost(
          recipes.orderHold({
            orderId: 'order-door-1',
            userId: USER,
            assetId: 'USDT',
            amount: amt('10'),
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await servicePost(
          recipes.withdrawHold({
            withdrawalId: 'withdraw-door-1',
            userId: USER,
            assetId: 'USDT',
            amount: amt('7'),
            rail: 'test',
          }),
        )
      ).statusCode,
    ).toBe(200);

    const balances = await serviceRead('/trpc/balances', { ownerType: 'user', ownerId: USER });
    expect(balances.statusCode).toBe(200);
    expect(balances.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'available', purpose: '', amount: '13' }),
        expect.objectContaining({ kind: 'hold', purpose: 'order:order-door-1', amount: '10' }),
        expect.objectContaining({ kind: 'hold', purpose: 'withdraw:withdraw-door-1', amount: '7' }),
      ]),
    );

    expect(
      (
        await servicePost(
          recipes.withdrawReverse({
            withdrawalId: 'withdraw-door-1',
            userId: USER,
            assetId: 'USDT',
            amount: amt('7'),
            rail: 'test',
          }),
        )
      ).statusCode,
    ).toBe(200);
    const reversed = await serviceRead('/trpc/balance', withdrawalHoldAccount(USER, 'USDT', 'withdraw-door-1'));
    const order = await serviceRead('/trpc/balance', orderHoldAccount(USER, 'USDT', 'order-door-1'));
    expect(reversed.json()).toMatchObject({ purpose: 'withdraw:withdraw-door-1', amount: '0' });
    expect(order.json()).toMatchObject({ purpose: 'order:order-door-1', amount: '10' });
  });

  it('halts new recipes at the operator freeze door and resumes only through authenticated unfreeze', async () => {
    const first = recipes.deposit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('5'),
      rail: 'test',
      railRef: 'before-freeze',
    });
    expect((await servicePost(first)).statusCode).toBe(200);

    const authorization = await operatorBearer();
    const frozen = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization },
      payload: { reason: 'promise-falsify reconciliation drift', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json()).toMatchObject({
      frozen: true,
      reason: 'promise-falsify reconciliation drift',
      actor: OPERATOR,
    });

    const blocked = recipes.deposit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('9'),
      rail: 'test',
      railRef: 'while-frozen',
    });
    const refusal = await servicePost(blocked);
    expect(refusal.statusCode).toBe(412);
    expect(refusal.json()).toMatchObject({ code: 'ledger.frozen' });
    expect((await serviceRead('/trpc/balance', userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '5' });

    const thawed = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers: { authorization },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(thawed.statusCode).toBe(200);
    expect(thawed.json()).toMatchObject({ frozen: false, reason: null, actor: OPERATOR });
    expect((await servicePost(blocked)).statusCode).toBe(200);
    expect((await serviceRead('/trpc/balance', userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '14' });
  });

  it('locks, draws, and releases loan recipes without commingling collateral', async () => {
    const setup = [
      recipes.deposit({
        userId: USER,
        assetId: 'BTC',
        amount: amt('2'),
        rail: 'test',
        railRef: 'loan-collateral',
      }),
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: 'loan-reserve-cash',
      }),
      recipes.feeCharge({
        chargeId: 'loan-reserve-fee',
        userId: USER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('1000'),
      }),
      recipes.loanReserveFund({
        fundingId: 'loan-door-fund',
        debtAssetId: 'USDT',
        amount: amt('1000'),
      }),
      recipes.loanCollateralLock({
        loanId: 'loan-door-a',
        userId: USER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
      recipes.loanCollateralLock({
        loanId: 'loan-door-b',
        userId: USER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
      recipes.loanDraw({
        loanId: 'loan-door-a',
        userId: USER,
        debtAssetId: 'USDT',
        principal: amt('1000'),
      }),
      recipes.loanCollateralRelease({
        loanId: 'loan-door-a',
        userId: USER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 1,
      }),
    ];

    for (const request of setup) {
      const response = await servicePost(request);
      expect(response.statusCode, `${request.reason}: ${response.body}`).toBe(200);
    }

    const loanA = await serviceRead('/trpc/balance', loanCollateralAccount(USER, 'BTC', 'loan-door-a'));
    const loanB = await serviceRead('/trpc/balance', loanCollateralAccount(USER, 'BTC', 'loan-door-b'));
    const reserve = await serviceRead('/trpc/balance', loanReserve('USDT'));
    const borrowerDebtAsset = await serviceRead('/trpc/balance', userAvailable(USER, 'USDT'));

    expect(loanA.json()).toMatchObject({ kind: 'collateral', purpose: 'loan:loan-door-a', amount: '0' });
    expect(loanB.json()).toMatchObject({ kind: 'collateral', purpose: 'loan:loan-door-b', amount: '1' });
    expect(reserve.json()).toMatchObject({ amount: '0' });
    expect(borrowerDebtAsset.json()).toMatchObject({ amount: '1000' });
  });
});

describe('promise-falsify public doors — D26-P2-12 spine reprove (unset / malformed)', () => {
  let app: FastifyInstance;
  let ledger: PublicDoorLedger;

  beforeEach(async () => {
    ledger = new PublicDoorLedger();
    app = Fastify({ logger: false });
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

  async function operatorBearer(): Promise<string> {
    const { token } = await issueAccessToken(
      {
        userId: OPERATOR,
        sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        scopes: ['admin:treasury'],
        tier: 'basic',
        mfa: true,
      },
      TOKENS,
    );
    return `Bearer ${token}`;
  }

  const deposit = (railRef: string, amount = '100') =>
    recipes.deposit({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'test',
      railRef,
    });

  it('refuses operator freeze when reason is missing — posting stays open', async () => {
    expect((await servicePost(deposit('before-unset-freeze'))).statusCode).toBe(200);

    const missing = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await operatorBearer() },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    expect(
      (
        await servicePost(
          recipes.deposit({
            userId: USER,
            assetId: 'USDT',
            amount: amt('50'),
            rail: 'test',
            railRef: 'after-unset-freeze-refused',
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '150' });
  });

  it('refuses operator freeze when reason is whitespace-only — no silent attributed halt', async () => {
    const spaces = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await operatorBearer() },
      payload: { reason: '            ' },
    });
    expect(spaces.statusCode).toBe(400);
    expect((await servicePost(deposit('while-freeze-unset'))).statusCode).toBe(200);
  });

  it('refuses unpurposed hold at the S2S post door and leaves available untouched', async () => {
    expect((await servicePost(deposit('purpose-seed-unset'))).statusCode).toBe(200);

    const lie: PostRequest = {
      idempotencyKey: 'trade.order.hold:unset-purpose-door',
      module: 'trade',
      reason: 'trade.order.hold',
      entries: [
        {
          account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: '' },
          direction: 'debit',
          amount: amt('25'),
        },
        { account: userAvailable(USER, 'USDT'), direction: 'credit', amount: amt('25') },
      ],
    };
    const refusal = await servicePost(lie);
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json().code).toBe(RECIPE_REQUIRED_CODE);
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '100' });
  });

  it('refuses unpurposed collateral at the S2S post door — two loans cannot share one pot', async () => {
    expect(
      (
        await servicePost(
          recipes.deposit({
            userId: USER,
            assetId: 'BTC',
            amount: amt('2'),
            rail: 'test',
            railRef: 'collateral-seed-unset',
          }),
        )
      ).statusCode,
    ).toBe(200);

    const lie: PostRequest = {
      idempotencyKey: 'bank.loan.collateral.lock:unset-purpose:0',
      module: 'bank',
      reason: 'loan.collateral.locked',
      entries: [
        { account: userAvailable(USER, 'BTC'), direction: 'credit', amount: amt('1') },
        {
          account: { ownerType: 'user', ownerId: USER, assetId: 'BTC', kind: 'collateral', purpose: '' },
          direction: 'debit',
          amount: amt('1'),
        },
      ],
    };
    const refusal = await servicePost(lie);
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json().code).toBe(RECIPE_REQUIRED_CODE);
    expect((await serviceBalance(userAvailable(USER, 'BTC'))).json()).toMatchObject({ amount: '2' });
  });

  it('refuses available with a purpose at the S2S post door — fungible pot must stay one row', async () => {
    expect((await servicePost(deposit('available-purpose-seed'))).statusCode).toBe(200);

    const lie: PostRequest = {
      idempotencyKey: 'bank.split.available:unset-purpose',
      module: 'bank',
      reason: 'bank.transfer',
      entries: [
        {
          account: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available', purpose: 'split-lie' },
          direction: 'credit',
          amount: amt('10'),
        },
        { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: amt('10') },
      ],
    };
    const refusal = await servicePost(lie);
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json().code).toBe(RECIPE_REQUIRED_CODE);
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '100', purpose: '' });
  });

  it('refuses construction of a loan draw with a blank loanId before the HTTP door', async () => {
    expect(() => recipes.loanDraw({ loanId: '', userId: USER, debtAssetId: 'USDT', principal: amt('1') })).toThrow(
      'loanId must be a non-blank id',
    );
    expect((await serviceBalance(loanReserve('USDT'))).json()).toMatchObject({ amount: '0' });
  });

  it('refuses loan draw against an unfunded reserve — reserve unset is not silent allow', async () => {
    expect((await servicePost(deposit('loan-draw-unfunded-seed'))).statusCode).toBe(200);

    const refusal = await servicePost(
      recipes.loanDraw({ loanId: 'loan-unfunded-reserve', userId: USER, debtAssetId: 'USDT', principal: amt('50') }),
    );
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json()).toMatchObject({ code: 'ledger.insufficient_funds' });
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '100' });
  });

  it('refuses loan draw at the public post door when principal is zero', async () => {
    const lie: PostRequest = {
      idempotencyKey: 'bank.loan.draw:zero-principal',
      module: 'bank',
      reason: 'loan.drawn',
      entries: [
        { account: loanReserve('USDT'), direction: 'credit', amount: amt('0') },
        { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: amt('0') },
      ],
    };
    const response = await servicePost(lie);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().code).toBe('ledger.invalid_entry');
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '0' });
  });

  it('refuses order hold at the public post door when ownerId is not a user uuid', async () => {
    const response = await servicePost(
      recipes.orderHold({ orderId: 'order-door-bad-owner', userId: 'not-a-uuid', assetId: 'USDT', amount: amt('1') }),
    );
    expect(response.statusCode).toBe(400);
    expect(String(response.json().message)).toMatch(/not-a-uuid/);
  });

  it('refuses an empty-entry post at the public door instead of posting nothing', async () => {
    const payload = JSON.stringify({ reason: 'no-entries', module: 'bank', entries: [] });
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/post',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it('refuses new recipes at the public post door while operator freeze is active', async () => {
    const frozen = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await operatorBearer() },
      payload: { reason: 'p2-12 spine reprove freeze', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(frozen.statusCode).toBe(200);

    const blocked = await servicePost(
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('1'),
        rail: 'test',
        railRef: 'after-freeze',
      }),
    );
    expect(blocked.statusCode).toBe(412);
    expect(blocked.json()).toMatchObject({ code: 'ledger.frozen' });
  });

  it('refuses an unbalanced post at the public door and writes nothing', async () => {
    expect((await servicePost(deposit('unbalance-seed'))).statusCode).toBe(200);

    const payload = JSON.stringify({
      idempotencyKey: 'trade.unbalanced:door',
      module: 'trade',
      reason: 'trade.fill',
      entries: [
        { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: '10' },
        { account: orderHoldAccount(USER, 'USDT', 'order:unbalanced'), direction: 'credit', amount: '9' },
      ],
    });
    const refusal = await app.inject({
      method: 'POST',
      url: '/trpc/post',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json()).toMatchObject({ code: RECIPE_REQUIRED_CODE });
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '100' });
  });

  it('refuses a JSON number amount at the public door — float money never enters', async () => {
    const payload = JSON.stringify({
      idempotencyKey: 'trade.json-number:door',
      module: 'trade',
      reason: 'trade.fill',
      entries: [
        { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: 10 },
        { account: orderHoldAccount(USER, 'USDT', 'order:json-number'), direction: 'credit', amount: 10 },
      ],
    });
    const refusal = await app.inject({
      method: 'POST',
      url: '/trpc/post',
      headers: {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-bank', SERVICE_SECRET, payload),
      },
      payload,
    });
    expect(refusal.statusCode).toBeGreaterThanOrEqual(400);
    expect(refusal.statusCode).toBeLessThan(500);
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '0' });
  });

  it('refuses a spend that would take a user negative — treasury is the only exception', async () => {
    expect((await servicePost(deposit('overdraft-seed', '10'))).statusCode).toBe(200);
    const refusal = await servicePost(recipes.orderHold({ orderId: 'overdraft-door', userId: USER, assetId: 'USDT', amount: amt('50') }));
    expect(refusal.statusCode).toBe(400);
    expect(refusal.json()).toMatchObject({ code: 'ledger.insufficient_funds' });
    expect((await serviceBalance(userAvailable(USER, 'USDT'))).json()).toMatchObject({ amount: '10' });
  });
});
