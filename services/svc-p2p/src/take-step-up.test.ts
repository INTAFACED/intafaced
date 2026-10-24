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
import { metTakeGate } from './take-gate-fixture.js';
import {
  TAKE_STEP_UP_SCOPE,
  TAKE_STEP_UP_WINDOW_SECONDS,
  createTakeStepUp,
  takeStepUpPayloadHash,
  unwiredTakeStepUp,
  type TakeStepUpCaller,
  type TakeStepUpFields,
} from './take-step-up.js';

/**
 * P-trade-orders-07: a take is confirmed with a fresh passkey or authenticator code. Identity's single-use
 * same-person approval for exactly this take opens a ten-minute window for that one session. Without it, with an API
 * key, in another session, after the window, or with a spent or foreign approval, nothing is reserved or locked.
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
const SECRET = 'p2p-step-up-edge-secret-long-enough';

/** What identity's consume does for a same-person row: hash, target, user and session must all match the mint. */
function identity() {
  const minted = new Map<string, { userId: string; sessionId: string; payloadHash: string }>();
  const consumed = new Map<string, string>();
  const calls: ActionApprovalConsumeInput[] = [];
  let down = false;
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      calls.push(input);
      // What fetch throws when identity does not answer: not identity's refusal.
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
        input.targetId !== TAKE_STEP_UP_SCOPE ||
        input.principalUserId !== row.userId ||
        input.principalSessionId !== row.sessionId
      ) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
      }
      consumed.set(input.approvalId, input.requestId ?? '');
      return {
        approvalId: input.approvalId,
        actionType: TAKE_STEP_UP_SCOPE,
        targetService: 'svc-p2p',
        targetId: TAKE_STEP_UP_SCOPE,
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
    /** Identity's `stepUp.complete` for `take`, as `userId` in `sessionId`. */
    mint(take: TakeStepUpFields, userId = TAKER, sessionId = SESSION): string {
      const approvalId = crypto.randomUUID();
      minted.set(approvalId, { userId, sessionId, payloadHash: takeStepUpPayloadHash(userId, take) });
      return approvalId;
    },
    goDown() {
      down = true;
    },
  };
}

describe('svc-p2p take confirmation (P-trade-orders-07)', () => {
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
      feeBps: 0,
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

  const sellOffer = () =>
    p2p.createOffer({
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

  function caller(stepUp: ReturnType<typeof createTakeStepUp>, options: { sid?: string } = {}) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-step-up');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: TAKER,
      userId: TAKER,
      sid: options.sid ?? SESSION,
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, { takeGate: metTakeGate(), takeStepUp: stepUp }).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-step-up',
      }),
    );
  }

  const takeOf = (offerId: string, amount = '10'): TakeStepUpFields => ({
    tradeId: crypto.randomUUID(),
    offerId,
    amount,
    method: 'sepa',
  });

  async function nothingReserved(offerId: string) {
    expect((await p2p.getOffer(offerId)).remainingAmt).toBe(parseAmount('100'));
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(0);
    // The ledger saw only the TEST funding: no escrow lock was posted.
    expect(ledger.journal()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  it('hashes the take the way identity mints the confirmation: actor plus the reviewed fields, the quote only when held', () => {
    const reviewed = { offerId: 'o', amount: '10.5', method: 'sepa' };
    const take = { tradeId: 't', ...reviewed };
    expect(takeStepUpPayloadHash(TAKER, take)).toBe(customerStepUpPayloadHash(TAKE_STEP_UP_SCOPE, { actor: TAKER, ...reviewed }));
    expect(takeStepUpPayloadHash(TAKER, { ...take, quoteId: 'q' })).toBe(
      customerStepUpPayloadHash(TAKE_STEP_UP_SCOPE, { actor: TAKER, ...reviewed, quoteId: 'q' }),
    );
    expect(takeStepUpPayloadHash(TAKER, { ...take, quoteId: 'q' })).not.toBe(takeStepUpPayloadHash(TAKER, take));
  });

  it('a take with no confirmation refuses auth.step_up_required and nothing is reserved or locked', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    await expect(c.trades.take({ ...takeOf(offer.id) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'auth.step_up_required' },
    });
    expect(id.calls).toHaveLength(0);
    await nothingReserved(offer.id);
    expect((await c.trades.stepUpWindow()).confirmedUntil).toBeNull();
  });

  it('a confirmation of this take places it once, and the same session takes again for ten minutes without another', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    const first = takeOf(offer.id);
    const approvalId = id.mint(first);
    const before = Date.now();
    const trade = await c.trades.take({ ...first, stepUpApprovalId: approvalId });
    expect(trade.status).toBe('escrowed');
    expect(id.calls).toHaveLength(1);
    expect(id.calls[0]).toMatchObject({
      approvalId,
      operationId: approvalId,
      targetService: 'svc-p2p',
      targetId: TAKE_STEP_UP_SCOPE,
      principalUserId: TAKER,
      principalSessionId: SESSION,
      requestId: `p2p:take-step-up:${first.tradeId}`,
    });
    const { confirmedUntil } = await c.trades.stepUpWindow();
    const until = Date.parse(confirmedUntil!);
    expect(until).toBeGreaterThan(before + (TAKE_STEP_UP_WINDOW_SECONDS - 5) * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + TAKE_STEP_UP_WINDOW_SECONDS * 1000 + 1000);

    // Inside the window: the next take needs no confirmation and identity is not asked.
    const second = await c.trades.take({ ...takeOf(offer.id, '5') });
    expect(second.status).toBe('escrowed');
    expect(id.calls).toHaveLength(1);
    expect((await p2p.getOffer(offer.id)).remainingAmt).toBe(parseAmount('85'));
  });

  it('a retry of the same take with the same confirmation passes it without asking identity again, and places nothing twice', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    const take = takeOf(offer.id);
    const approvalId = id.mint(take);
    await c.trades.take({ ...take, stepUpApprovalId: approvalId });
    // The confirmation holds for its own take; the order id is then the service's own duplicate refusal.
    await expect(c.trades.take({ ...take, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'p2p.trade_exists' },
    });
    expect(id.calls).toHaveLength(1);
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(1);
    expect((await p2p.getOffer(offer.id)).remainingAmt).toBe(parseAmount('90'));
  });

  it('a lost reply after identity consumed: the same take asks again under the same request id and is placed', async () => {
    const offer = await sellOffer();
    const id = identity();
    const stepUp = createTakeStepUp({ sql, approvals: id.consumer });
    const take = takeOf(offer.id);
    const approvalId = id.mint(take);
    // Identity consumed, but the reply never reached svc-p2p: no row was written.
    await id.consumer.consume({
      approvalId,
      operationId: approvalId,
      payloadHash: takeStepUpPayloadHash(TAKER, take),
      targetService: 'svc-p2p',
      targetId: TAKE_STEP_UP_SCOPE,
      expectedVersion: '1',
      principalUserId: TAKER,
      principalSessionId: SESSION,
      requestId: `p2p:take-step-up:${take.tradeId}`,
    });
    expect((await caller(stepUp).trades.take({ ...take, stepUpApprovalId: approvalId })).status).toBe('escrowed');
  });

  it('a confirmation of one take never places another, and a spent one never places a second order', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    const reviewed = takeOf(offer.id);
    const approvalId = id.mint(reviewed);
    // Another amount under the same confirmation: identity refuses the hash.
    await expect(c.trades.take({ ...reviewed, amount: '50', stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    await nothingReserved(offer.id);
    await c.trades.take({ ...reviewed, stepUpApprovalId: approvalId });
    // The spent confirmation with another order id: refused from svc-p2p's own record.
    await expect(c.trades.take({ ...takeOf(offer.id), stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(1);
  });

  it('another session of the same person, an API key, and a token with no session each need their own confirmation', async () => {
    const offer = await sellOffer();
    const id = identity();
    const stepUp = createTakeStepUp({ sql, approvals: id.consumer });
    const take = takeOf(offer.id);
    await caller(stepUp).trades.take({ ...take, stepUpApprovalId: id.mint(take) });

    await expect(caller(stepUp, { sid: OTHER_SESSION }).trades.take({ ...takeOf(offer.id) })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_required' },
    });
    // A confirmation proved in this session cannot be spent from another one.
    const elsewhere = takeOf(offer.id);
    await expect(
      caller(stepUp, { sid: OTHER_SESSION }).trades.take({ ...elsewhere, stepUpApprovalId: id.mint(elsewhere) }),
    ).rejects.toMatchObject({ cause: { code: 'auth.step_up_failed' } });
    // An API key never confirms a take, with or without an approval, even in the session that confirmed one.
    const keyed = takeOf(offer.id);
    const key: TakeStepUpCaller = { userId: TAKER, sessionId: SESSION, viaApiKey: true };
    await expect(stepUp.assertConfirmed(key, keyed, id.mint(keyed))).rejects.toMatchObject({ code: 'auth.step_up_required' });
    await expect(stepUp.assertConfirmed(key, keyed, undefined)).rejects.toMatchObject({ code: 'auth.step_up_required' });
    await expect(stepUp.window(key)).rejects.toMatchObject({ code: 'auth.step_up_required' });
    // A token with no session is refused by the edge context first; the confirmation refuses it on its own too.
    await expect(stepUp.assertConfirmed({ userId: TAKER, sessionId: undefined, viaApiKey: false }, keyed, undefined)).rejects.toMatchObject(
      {
        code: 'auth.step_up_required',
      },
    );
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(1);
  });

  it('after ten minutes the window has ended: the next take refuses auth.step_up_expired until confirmed again', async () => {
    const offer = await sellOffer();
    const id = identity();
    const stepUp = createTakeStepUp({ sql, approvals: id.consumer });
    const c = caller(stepUp);
    const take = takeOf(offer.id);
    await c.trades.take({ ...take, stepUpApprovalId: id.mint(take) });
    await sql`
      UPDATE p2p.take_step_ups
         SET confirmed_at = now() - make_interval(secs => ${TAKE_STEP_UP_WINDOW_SECONDS + 1}),
             expires_at = now() - interval '1 second'
    `;
    expect((await c.trades.stepUpWindow()).confirmedUntil).toBeNull();
    await expect(c.trades.take({ ...takeOf(offer.id) })).rejects.toMatchObject({ cause: { code: 'auth.step_up_expired' } });
    expect(await sql`SELECT id FROM p2p.p2p_trades`).toHaveLength(1);
    const next = takeOf(offer.id);
    expect((await c.trades.take({ ...next, stepUpApprovalId: id.mint(next) })).status).toBe('escrowed');
  });

  it('an unknown confirmation asks again; identity unreachable or unwired refuses as unverifiable, nothing reserved', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    await expect(c.trades.take({ ...takeOf(offer.id), stepUpApprovalId: crypto.randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'auth.step_up_failed' },
    });
    const take = takeOf(offer.id);
    const approvalId = id.mint(take);
    id.goDown();
    // A new passkey would fail the same way, so the person is not asked for one.
    await expect(c.trades.take({ ...take, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'p2p.step_up_unverifiable' },
    });
    const noIdentity = caller(createTakeStepUp({ sql, approvals: unwiredApprovalConsumer() }));
    await expect(noIdentity.trades.take({ ...take, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'p2p.step_up_unverifiable' },
    });
    await expect(caller(unwiredTakeStepUp()).trades.take({ ...takeOf(offer.id) })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'p2p.step_up_unverifiable' },
    });
    await nothingReserved(offer.id);
    expect(await sql`SELECT approval_id FROM p2p.take_step_ups`).toHaveLength(0);
  });

  it('a confirmation spent on a take that was then refused never places other terms, nor the same ones after its window', async () => {
    const offer = await sellOffer();
    const id = identity();
    const c = caller(createTakeStepUp({ sql, approvals: id.consumer }));
    // Confirmed, then refused by the take's own checks: more than the ad's per-order maximum.
    const tooMuch = { ...takeOf(offer.id), amount: '60' };
    const approvalId = id.mint(tooMuch);
    await expect(c.trades.take({ ...tooMuch, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'p2p.amount_above_max' },
    });
    await nothingReserved(offer.id);
    // The same order id and the same approval with other terms: not a retry of what was confirmed.
    await expect(c.trades.take({ ...tooMuch, amount: '10', stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    await sql`UPDATE p2p.take_step_ups SET confirmed_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'`;
    await expect(c.trades.take({ ...tooMuch, stepUpApprovalId: approvalId })).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    await nothingReserved(offer.id);
    expect(id.calls).toHaveLength(1);
  });

  it('a consumed row that is not this person’s same-person confirmation of a take refuses', async () => {
    const offer = await sellOffer();
    const take = takeOf(offer.id);
    const forged = (patch: Partial<ActionApproval>): ActionApprovalConsumer => ({
      async consume(input) {
        return {
          approvalId: input.approvalId,
          actionType: TAKE_STEP_UP_SCOPE,
          targetService: 'svc-p2p',
          targetId: TAKE_STEP_UP_SCOPE,
          expectedVersion: '1',
          payloadHash: input.payloadHash,
          requesterId: TAKER,
          approverId: TAKER,
          policyVersion: 'v1',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          status: 'CONSUMED',
          operationId: input.approvalId,
          kind: 'same_person',
          ...patch,
        };
      },
    });
    for (const patch of [
      { kind: 'four_eyes' as const, approverId: MAKER },
      { requesterId: MAKER, approverId: MAKER },
      { targetId: 'pay.step_up.payoutDestination.set' },
      { status: 'APPROVED' as const },
    ]) {
      const c = caller(createTakeStepUp({ sql, approvals: forged(patch) }));
      await expect(c.trades.take({ ...take, stepUpApprovalId: crypto.randomUUID() })).rejects.toMatchObject({
        cause: { code: 'auth.step_up_failed' },
      });
    }
    await nothingReserved(offer.id);
  });
});
