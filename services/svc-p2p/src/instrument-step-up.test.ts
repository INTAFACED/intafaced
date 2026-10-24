import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
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
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';
import { InstrumentService } from './instrument-service.js';
import { P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';
import { confirmedReleaseStepUp, confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';
import {
  INSTRUMENT_STEP_UP_SCOPE,
  INSTRUMENT_STEP_UP_WINDOW_SECONDS,
  createInstrumentStepUp,
  instrumentStepUpPayloadHash,
  unwiredInstrumentStepUp,
  type InstrumentChange,
  type InstrumentStepUp,
} from './instrument-step-up.js';

/**
 * P-ads-merchant-18 (J-p2p-04 #3): adding, changing or removing a payment method is confirmed with a fresh passkey or
 * authenticator code. Identity's single-use same-person approval for exactly this change lets it through once and opens
 * a ten-minute window for that session. Without it, with an API key, in another session, after the window, or with a
 * spent approval, nothing is stored. With no instrument key, nothing is saved and no confirmation is spent.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const SESSION = '55555555-5555-4555-8555-555555555555';
const OTHER_SESSION = '66666666-6666-4666-8666-666666666666';
const SECRET = 'p2p-instrument-step-up-edge-secret-long';
const DETAILS = { account_reference: 'ref-owner' };

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
        input.targetId !== INSTRUMENT_STEP_UP_SCOPE ||
        input.principalUserId !== row.userId ||
        input.principalSessionId !== row.sessionId
      ) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
      }
      consumed.set(input.approvalId, input.requestId ?? '');
      return {
        approvalId: input.approvalId,
        actionType: INSTRUMENT_STEP_UP_SCOPE,
        targetService: 'svc-p2p',
        targetId: INSTRUMENT_STEP_UP_SCOPE,
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
    /** Identity's `stepUp.complete` for `change` of `instrumentId`, as `userId` in `sessionId`. */
    mint(instrumentId: string, change: InstrumentChange, userId = OWNER, sessionId = SESSION): string {
      const approvalId = crypto.randomUUID();
      minted.set(approvalId, { userId, sessionId, payloadHash: instrumentStepUpPayloadHash(userId, instrumentId, change) });
      return approvalId;
    },
    goDown() {
      down = true;
    },
  };
}

describe('svc-p2p payment-method confirmation (P-ads-merchant-18, J-p2p-04 #3)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let p2p!: P2pService;
  let instruments!: InstrumentService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: 'DE',
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    p2p = new P2pService(sql, new MemoryLedger(), new MemoryEventBus('svc-p2p'), {
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
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function caller(stepUp: InstrumentStepUp, options: { sid?: string; viaApiKey?: boolean; keyProvider?: 'none' | 'local-test' } = {}) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-instrument-step-up');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const principal = {
      sub: OWNER,
      userId: OWNER,
      sid: options.sid ?? SESSION,
      ...(options.viaApiKey ? { kid: 'key-1' } : {}),
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, {
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
      releaseStepUp: confirmedReleaseStepUp(),
      instrumentStepUp: stepUp,
      instrumentKeyProvider: options.keyProvider ?? 'local-test',
    }).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-instrument-step-up',
      }),
    );
  }

  const add = (instrumentId: string, stepUpApprovalId?: string) => ({
    instrumentId,
    methodId: 'sepa',
    country: 'DE',
    fiatCurrency: 'EUR',
    details: DETAILS,
    ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
  });
  const stored = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM p2p.payment_instruments`)[0]!.n;

  it('hashes the change the way identity mints the confirmation: the person, the method and the kind of change', () => {
    expect(instrumentStepUpPayloadHash(OWNER, 'i', 'create')).toBe(
      customerStepUpPayloadHash(INSTRUMENT_STEP_UP_SCOPE, { actor: OWNER, instrumentId: 'i', change: 'create' }),
    );
    expect(instrumentStepUpPayloadHash(OWNER, 'i', 'create')).not.toBe(instrumentStepUpPayloadHash(OWNER, 'i', 'remove'));
  });

  it('saving with no confirmation refuses auth.step_up_required and stores nothing', async () => {
    const id = identity();
    await expect(
      caller(createInstrumentStepUp({ sql, approvals: id.consumer })).instruments.create(add(crypto.randomUUID())),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'auth.step_up_required' },
    });
    expect(id.calls).toHaveLength(0);
    expect(await stored()).toBe(0);
  });

  it('a confirmation of this add saves it and opens a ten-minute window for this session only', async () => {
    const id = identity();
    const stepUp = createInstrumentStepUp({ sql, approvals: id.consumer });
    const c = caller(stepUp);
    const first = crypto.randomUUID();
    const approvalId = id.mint(first, 'create');
    expect(await c.instruments.create(add(first, approvalId))).toMatchObject({ id: first, status: 'active' });
    expect(id.calls[0]).toMatchObject({
      approvalId,
      targetService: 'svc-p2p',
      targetId: INSTRUMENT_STEP_UP_SCOPE,
      principalUserId: OWNER,
      principalSessionId: SESSION,
      requestId: `p2p:instrument-step-up:create:${first}`,
    });
    const window = await c.instruments.stepUpWindow();
    const until = Date.parse(window.confirmedUntil!);
    expect(until - Date.now()).toBeGreaterThan((INSTRUMENT_STEP_UP_WINDOW_SECONDS - 30) * 1000);

    // Inside the window this session removes it with no new confirmation; identity is not asked again.
    expect(await c.instruments.remove({ instrumentId: first })).toMatchObject({ id: first, status: 'removed' });
    expect(id.calls).toHaveLength(1);

    // Another session, or an API key, is not covered.
    await expect(caller(stepUp, { sid: OTHER_SESSION }).instruments.create(add(crypto.randomUUID()))).rejects.toMatchObject({
      cause: { code: 'auth.step_up_required' },
    });
    // An API key never changes payment methods (refused before the confirmation is even looked at).
    await expect(caller(stepUp, { viaApiKey: true }).instruments.create(add(crypto.randomUUID()))).rejects.toThrow();
    expect(await stored()).toBe(1);
  });

  it('after the window a change asks again; a spent or mismatched approval is refused and stores nothing', async () => {
    const id = identity();
    const stepUp = createInstrumentStepUp({ sql, approvals: id.consumer });
    const c = caller(stepUp);
    const first = crypto.randomUUID();
    const approvalId = id.mint(first, 'create');
    await c.instruments.create(add(first, approvalId));
    await sql`UPDATE p2p.instrument_step_ups SET confirmed_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'`;
    await expect(c.instruments.create(add(crypto.randomUUID()))).rejects.toMatchObject({ cause: { code: 'auth.step_up_expired' } });
    // The spent approval names another method now: refused, nothing stored.
    await expect(c.instruments.create(add(crypto.randomUUID(), approvalId))).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    // An approval for removing a method does not add one.
    const other = crypto.randomUUID();
    await expect(c.instruments.create(add(other, id.mint(other, 'remove')))).rejects.toMatchObject({
      cause: { code: 'auth.step_up_failed' },
    });
    expect(await stored()).toBe(1);
  });

  it('identity not answering, or not wired, refuses p2p.step_up_unverifiable with nothing stored', async () => {
    const id = identity();
    const instrumentId = crypto.randomUUID();
    const approvalId = id.mint(instrumentId, 'create');
    id.goDown();
    await expect(
      caller(createInstrumentStepUp({ sql, approvals: id.consumer })).instruments.create(add(instrumentId, approvalId)),
    ).rejects.toMatchObject({ cause: { code: 'p2p.step_up_unverifiable' } });
    await expect(caller(unwiredInstrumentStepUp()).instruments.create(add(crypto.randomUUID()))).rejects.toMatchObject({
      cause: { code: 'p2p.step_up_unverifiable' },
    });
    expect(await stored()).toBe(0);
  });

  it('with no instrument key nothing is saved and the confirmation is not spent', async () => {
    const id = identity();
    const instrumentId = crypto.randomUUID();
    const approvalId = id.mint(instrumentId, 'create');
    await expect(
      caller(createInstrumentStepUp({ sql, approvals: id.consumer }), { keyProvider: 'none' }).instruments.create(
        add(instrumentId, approvalId),
      ),
    ).rejects.toMatchObject({ cause: { code: 'p2p.instrument_kms_required' } });
    expect(id.calls).toHaveLength(0);
    expect(await stored()).toBe(0);
  });

  it('removing needs a confirmation too', async () => {
    const id = identity();
    const instrumentId = crypto.randomUUID();
    await instruments.createInstrument({ ownerId: OWNER, ...add(instrumentId), label: 'sepa' });
    const c = caller(createInstrumentStepUp({ sql, approvals: id.consumer }));
    await expect(c.instruments.remove({ instrumentId })).rejects.toMatchObject({ cause: { code: 'auth.step_up_required' } });
    expect(await c.instruments.remove({ instrumentId, stepUpApprovalId: id.mint(instrumentId, 'remove') })).toMatchObject({
      status: 'removed',
    });
  });
});
