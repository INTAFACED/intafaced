import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import {
  customerStepUpPayloadHash,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionApprovalConsumeError, unwiredApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';
import { confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';
import {
  RELEASE_STEP_UP_SCOPE,
  RELEASE_STEP_UP_WINDOW_SECONDS,
  createReleaseStepUp,
  releaseStepUpPayloadHash,
  unwiredReleaseStepUp,
  type ReleaseStepUp,
} from './release-step-up.js';

/**
 * P-trade-orders-07 and -16: a release is confirmed with a fresh passkey or authenticator code. Identity's single-use
 * same-person approval for exactly this order releases it once and opens a ten-minute release window for that session.
 * Without it, with an API key, in another session, after the window, or with a spent approval, nothing is decided and
 * the escrow stays held. A second press on a released order returns that order and posts nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const SESSION = '55555555-5555-4555-8555-555555555555';
const OTHER_SESSION = '66666666-6666-4666-8666-666666666666';
const ASSET = 'USDT';
const SECRET = 'p2p-release-step-up-edge-secret-long';

/** What identity's consume does for a same-person row: hash, target, user and session must all match the mint. */
function identity() {
  const minted = new Map<string, { userId: string; sessionId: string; payloadHash: string }>();
  const consumed = new Map<string, string>();
  const calls: ActionApprovalConsumeInput[] = [];
  let down = false;
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      calls.push(input);
      if (down) throw new TypeError('fetch failed');
      const row = minted.get(input.approvalId);
      if (!row) throw new ActionApprovalConsumeError('approval not found', 'action_approval.consume_failed');
      const spentBy = consumed.get(input.approvalId);
      if (spentBy !== undefined && spentBy !== input.requestId) {
        throw new ActionApprovalConsumeError('approval already consumed', 'action_approval.consume_failed');
      }
      if (
        input.payloadHash !== row.payloadHash ||
        input.targetService !== 'svc-p2p' ||
        input.targetId !== RELEASE_STEP_UP_SCOPE ||
        input.principalUserId !== row.userId ||
        input.principalSessionId !== row.sessionId
      ) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
      }
      consumed.set(input.approvalId, input.requestId ?? '');
      return {
        approvalId: input.approvalId,
        actionType: RELEASE_STEP_UP_SCOPE,
        targetService: 'svc-p2p',
        targetId: RELEASE_STEP_UP_SCOPE,
        expectedVersion: '1',
        payloadHash: row.payloadHash,
        requesterId: row.userId,
        approverId: row.userId,
        policyVersion: 'v1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.approvalId,
        kind: 'same_person',
      } satisfies ActionApproval;
    },
  };
  return {
    consumer,
    calls,
    /** Identity's `stepUp.complete` for releasing `tradeId`, as `userId` in `sessionId`. */
    mint(tradeId: string, userId = MAKER, sessionId = SESSION): string {
      const approvalId = crypto.randomUUID();
      minted.set(approvalId, { userId, sessionId, payloadHash: releaseStepUpPayloadHash(userId, tradeId) });
      return approvalId;
    },
    goDown() {
      down = true;
    },
  };
}

describe('svc-p2p release confirmation (P-trade-orders-07, -16)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let p2p!: P2pService;
  let instruments!: InstrumentService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-maker' },
      instrumentId: crypto.randomUUID(),
    });
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 100,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function caller(stepUp: ReleaseStepUp, options: { userId?: string; sid?: string } = {}) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-release-step-up');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const userId = options.userId ?? MAKER;
    const principal = {
      sub: userId,
      userId,
      sid: options.sid ?? SESSION,
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, {
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
      releaseStepUp: stepUp,
    }).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-release-step-up',
      }),
    );
  }

  /** A TEST order of 10 USDT the buyer marked paid. */
  async function paidOrder() {
    const offer = await p2p.createOffer({
      makerId: MAKER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('1'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('100'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });
    const trade = await p2p.takeOffer({
      offerId: offer.id,
      takerId: TAKER,
      amount: parseAmount('10'),
      tradeId: crypto.randomUUID(),
      method: 'sepa',
    });
    await p2p.markFiatSent(trade.id, TAKER);
    return trade.id;
  }

  const releases = () => ledger.journal().filter((tx) => tx.reason === 'p2p.escrow.release');

  async function stillHeld(tradeId: string) {
    expect((await p2p.getTrade(tradeId)).status).toBe('fiat_sent');
    expect(releases()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  it('hashes the release the way identity mints the confirmation: the seller and the order', () => {
    expect(releaseStepUpPayloadHash(MAKER, 't')).toBe(customerStepUpPayloadHash(RELEASE_STEP_UP_SCOPE, { actor: MAKER, tradeId: 't' }));
    expect(releaseStepUpPayloadHash(MAKER, 't')).not.toBe(releaseStepUpPayloadHash(MAKER, 'u'));
  });

  it('a release with no confirmation refuses auth.step_up_required and the escrow stays held', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    await expect(caller(createReleaseStepUp({ sql, approvals: id.consumer })).trades.confirmReceived({ tradeId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'auth.step_up_required' },
    });
    expect(id.calls).toHaveLength(0);
    await stillHeld(tradeId);
  });

  it('a confirmation of this release releases once; a second press returns the same order and posts nothing', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    const c = caller(createReleaseStepUp({ sql, approvals: id.consumer }));
    const approvalId = id.mint(tradeId);
    // The review shows what the release will post: the fee frozen at take (100 bps here) off the escrowed 10.
    expect(await c.trades.get({ tradeId })).toMatchObject({
      releasePreview: { fee: '0.1', netAmount: '9.9' },
      fee: null,
      escrowHeld: '10',
    });
    const released = await c.trades.confirmReceived({ tradeId, stepUpApprovalId: approvalId });
    // Posted: nothing of this order is left in escrow, and the fee is the published rate it was taken under.
    expect(await c.trades.get({ tradeId })).toMatchObject({
      releasePreview: null,
      fee: '0.1',
      netAmount: '9.9',
      escrowHeld: '0',
      feeBps: 100,
    });
    expect(await c.fees.schedule()).toEqual({ feeBps: 100, chargedOn: 'release', basis: 'released_amount' });
    expect(released).toMatchObject({ id: tradeId, status: 'released', resolution: 'released' });
    expect(id.calls).toHaveLength(1);
    expect(id.calls[0]).toMatchObject({
      approvalId,
      targetService: 'svc-p2p',
      targetId: RELEASE_STEP_UP_SCOPE,
      principalUserId: MAKER,
      principalSessionId: SESSION,
      requestId: `p2p:release-step-up:${tradeId}`,
    });
    expect(releases()).toHaveLength(1);

    // Pressed again, with the same confirmation or none at all: the same order, nothing posted, identity not asked.
    expect(await c.trades.confirmReceived({ tradeId, stepUpApprovalId: approvalId })).toEqual(released);
    expect(await c.trades.confirmReceived({ tradeId })).toEqual(released);
    expect(id.calls).toHaveLength(1);
    expect(releases()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a lost reply after identity consumed: the same release asks again under the same request id and releases', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    const stepUp = createReleaseStepUp({ sql, approvals: id.consumer });
    const approvalId = id.mint(tradeId);
    await id.consumer.consume({
      approvalId,
      operationId: approvalId,
      payloadHash: releaseStepUpPayloadHash(MAKER, tradeId),
      targetService: 'svc-p2p',
      targetId: RELEASE_STEP_UP_SCOPE,
      expectedVersion: '1',
      principalUserId: MAKER,
      principalSessionId: SESSION,
      requestId: `p2p:release-step-up:${tradeId}`,
    });
    expect((await caller(stepUp).trades.confirmReceived({ tradeId, stepUpApprovalId: approvalId })).status).toBe('released');
    expect(releases()).toHaveLength(1);
  });

  it('a confirmation of one order never releases another', async () => {
    const first = await paidOrder();
    const second = await paidOrder();
    const id = identity();
    const c = caller(createReleaseStepUp({ sql, approvals: id.consumer }));
    const approvalId = id.mint(first);
    // Identity refuses the hash of the other order.
    await expect(c.trades.confirmReceived({ tradeId: second, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    await stillHeld(second);
    await c.trades.confirmReceived({ tradeId: first, stepUpApprovalId: approvalId });
    // Spent on the first: svc-p2p's own record refuses it for the second.
    await expect(c.trades.confirmReceived({ tradeId: second, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    expect((await p2p.getTrade(second)).status).toBe('fiat_sent');
    expect(releases()).toHaveLength(1);
  });

  it('one confirmation covers this session’s releases for ten minutes; then the next refuses auth.step_up_expired', async () => {
    const first = await paidOrder();
    const second = await paidOrder();
    const third = await paidOrder();
    const id = identity();
    const c = caller(createReleaseStepUp({ sql, approvals: id.consumer }));
    expect((await c.trades.releaseStepUpWindow()).confirmedUntil).toBeNull();
    const before = Date.now();
    await c.trades.confirmReceived({ tradeId: first, stepUpApprovalId: id.mint(first) });
    const until = Date.parse((await c.trades.releaseStepUpWindow()).confirmedUntil!);
    expect(until).toBeGreaterThan(before + (RELEASE_STEP_UP_WINDOW_SECONDS - 5) * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + RELEASE_STEP_UP_WINDOW_SECONDS * 1000 + 1000);
    // Inside the window: the next release needs nothing more and identity is not asked.
    expect((await c.trades.confirmReceived({ tradeId: second })).status).toBe('released');
    expect(id.calls).toHaveLength(1);
    // Another session of the same seller is not covered.
    await expect(
      caller(createReleaseStepUp({ sql, approvals: id.consumer }), { sid: OTHER_SESSION }).trades.confirmReceived({ tradeId: third }),
    ).rejects.toMatchObject({
      cause: { code: 'auth.step_up_required' },
    });
    await sql`
      UPDATE p2p.release_step_ups
         SET confirmed_at = now() - make_interval(secs => ${RELEASE_STEP_UP_WINDOW_SECONDS + 1}),
             expires_at = now() - interval '1 second'
    `;
    expect((await c.trades.releaseStepUpWindow()).confirmedUntil).toBeNull();
    await expect(c.trades.confirmReceived({ tradeId: third })).rejects.toMatchObject({ cause: { code: 'auth.step_up_expired' } });
    expect((await p2p.getTrade(third)).status).toBe('fiat_sent');
    expect(releases()).toHaveLength(2);
    expect((await c.trades.confirmReceived({ tradeId: third, stepUpApprovalId: id.mint(third) })).status).toBe('released');
  });

  it('a take’s confirmation window never covers a release', async () => {
    const tradeId = await paidOrder();
    // The seller's session confirmed a take a moment ago: that record is the take's, not the release's.
    await sql`
      INSERT INTO p2p.take_step_ups (approval_id, user_id, session_id, trade_id, payload_hash, confirmed_at, expires_at)
      VALUES ('take-approval', ${MAKER}, ${SESSION}, ${crypto.randomUUID()}, 'sha256:take', now(), now() + interval '10 minutes')
    `;
    const id = identity();
    await expect(caller(createReleaseStepUp({ sql, approvals: id.consumer })).trades.confirmReceived({ tradeId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_required' },
    });
    await stillHeld(tradeId);
  });

  it('another session, an API key, and a token with no session each need their own confirmation', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    const stepUp = createReleaseStepUp({ sql, approvals: id.consumer });
    // Proved in this session, spent from another one: identity refuses.
    await expect(
      caller(stepUp, { sid: OTHER_SESSION }).trades.confirmReceived({ tradeId, stepUpApprovalId: id.mint(tradeId) }),
    ).rejects.toMatchObject({ cause: { code: 'auth.step_up_failed' } });
    // An API key never releases, with or without an approval.
    const key = { userId: MAKER, sessionId: SESSION, viaApiKey: true };
    await expect(stepUp.assertConfirmed(key, tradeId, id.mint(tradeId))).rejects.toMatchObject({ code: 'auth.step_up_required' });
    await expect(stepUp.assertConfirmed(key, tradeId, undefined)).rejects.toMatchObject({ code: 'auth.step_up_required' });
    await expect(stepUp.window(key)).rejects.toMatchObject({ code: 'auth.step_up_required' });
    await expect(
      stepUp.assertConfirmed({ userId: MAKER, sessionId: undefined, viaApiKey: false }, tradeId, id.mint(tradeId)),
    ).rejects.toMatchObject({
      code: 'auth.step_up_required',
    });
    await stillHeld(tradeId);
  });

  it('the buyer, a stranger and a disputed order are refused by the service before any confirmation is asked for', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    const stepUp = createReleaseStepUp({ sql, approvals: id.consumer });
    await expect(caller(stepUp, { userId: TAKER }).trades.confirmReceived({ tradeId })).rejects.toMatchObject({
      cause: { code: 'p2p.not_the_seller' },
    });
    await expect(
      caller(stepUp, { userId: '33333333-3333-4333-8333-333333333333' }).trades.confirmReceived({ tradeId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await p2p.openDispute({ tradeId, openedBy: MAKER, reason: 'TEST payment not received' });
    await expect(caller(stepUp).trades.confirmReceived({ tradeId, stepUpApprovalId: id.mint(tradeId) })).rejects.toMatchObject({
      cause: { code: 'p2p.dispute_already_open' },
    });
    expect(id.calls).toHaveLength(0);
    expect(releases()).toHaveLength(0);
  });

  it('an unpublished fee has no schedule: the read refuses p2p.fee_bps_unset, never a made-up rate', async () => {
    const unset = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments });
    const c = createP2pRouter(unset, instruments, undefined, {}).createCaller(
      createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' })({ headers: {}, id: 'req-fee' }),
    );
    await expect(c.fees.schedule()).rejects.toMatchObject({ cause: { code: 'p2p.fee_bps_unset' } });
  });

  it('identity unreachable or unwired refuses as unverifiable and the escrow stays held', async () => {
    const tradeId = await paidOrder();
    const id = identity();
    const approvalId = id.mint(tradeId);
    id.goDown();
    await expect(
      caller(createReleaseStepUp({ sql, approvals: id.consumer })).trades.confirmReceived({ tradeId, stepUpApprovalId: approvalId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'p2p.step_up_unverifiable' } });
    await expect(
      caller(createReleaseStepUp({ sql, approvals: unwiredApprovalConsumer() })).trades.confirmReceived({
        tradeId,
        stepUpApprovalId: approvalId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'p2p.step_up_unverifiable' } });
    await expect(caller(unwiredReleaseStepUp()).trades.confirmReceived({ tradeId, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'p2p.step_up_unverifiable' },
    });
    await stillHeld(tradeId);
  });
});
