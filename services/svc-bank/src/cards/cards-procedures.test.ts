import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { createBankServices, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { CardService } from './card-service.js';
import { cardIssuerFor, cardProgrammeOutput, cardSim, type CardIssuerAdapter } from './issuer.js';
import { createBankRouter } from '../router.js';
import { createStepUpGate } from '../step-up/step-up-gate.js';

/**
 * Customer card procedures (BANKCARDS items 1–8).
 *
 * The seam is the router the customer app calls. card-sim may issue, limit,
 * switch channels and replace, and it says simulated. It must not invent a PAN,
 * PIN, wallet payload or cashback balance. A non-simulated issuer fixture is
 * the only path that returns those, and the database must not keep the secret.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));
const SIMULATED_DOWN = readFileSync(join(drizzle, '0024_card_simulated_true.down.sql'), 'utf8');
const SIMULATED_UP = readFileSync(join(drizzle, '0024_card_simulated_true.sql'), 'utf8');

const EDGE_SECRET = 'a-bank-card-procedures-edge-secret-long-enough';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const FEE_PAYER = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const PAN = '4242424242424242';
// Not purely digits: the stored-rows dump holds random UUIDs, and a bare 3-digit CVV can occur inside one by chance.
const CVV = 'cvv-909';
const PIN = '135790';
const WALLET_PAYLOAD = 'wallet-payload-test';
const ADDRESS = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Engine',
  city: 'London',
  postalCode: 'SW1A 1AA',
  country: 'GB',
} as const;

const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-bank' });

class FakeIdentity implements ActionApprovalConsumer {
  private readonly rows = new Map<string, { userId: string; sessionId: string; actionType: string; hash: string; consumed: boolean }>();
  private n = 0;

  approve(actionType: string, fields: Record<string, string>): string {
    const id = `approval-${++this.n}`;
    this.rows.set(id, {
      userId: HOLDER,
      sessionId: SID,
      actionType,
      hash: bankActionPayloadHash(actionType, fields),
      consumed: false,
    });
    return id;
  }

  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    const refuse = (code: string): never => {
      throw new ActionApprovalConsumeError(
        `identity refused consume (412) {"message":"x [action_approval.${code}]"}`,
        'action_approval.consume_failed',
      );
    };
    const row = this.rows.get(input.approvalId);
    if (!row) return refuse('not_found');
    if (input.targetService !== 'svc-bank' || input.targetId !== row.actionType || input.operationId !== input.approvalId)
      return refuse('target_mismatch');
    if (row.hash !== input.payloadHash) return refuse('payload_mismatch');
    if (row.userId !== input.principalUserId || row.sessionId !== input.principalSessionId) return refuse('not_requester');
    if (row.consumed) return refuse('consumed');
    row.consumed = true;
    return {
      approvalId: input.approvalId,
      actionType: row.actionType,
      targetService: 'svc-bank',
      targetId: input.targetId,
      expectedVersion: '1',
      payloadHash: row.hash,
      requesterId: row.userId,
      approverId: row.userId,
      policyVersion: 'step-up-v1',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      status: 'CONSUMED',
      operationId: input.approvalId,
      kind: 'same_person',
    };
  }
}

function liveIssuer(): CardIssuerAdapter {
  const programme = cardProgrammeOutput({ id: 'outside-issuer', simulated: false, displayName: 'Connected card issuer' });
  const sim = cardSim();
  return {
    programme,
    issue: (input) => sim.issue(input),
    respondToAuthorization: (input) => sim.respondToAuthorization(input),
    setStatus: (input) => sim.setStatus(input),
    revealCredentials: async () => ({ pan: PAN, expiry: '12/30', cvv: CVV }),
    revealPin: async () => ({ pin: PIN }),
    setPin: async () => undefined,
    provisionWallet: async () => ({ payload: WALLET_PAYLOAD }),
  };
}

function countingLiveIssuer(): {
  issuer: CardIssuerAdapter;
  calls: { revealCredentials: number; revealPin: number; setPin: number };
} {
  const inner = liveIssuer();
  const calls = { revealCredentials: 0, revealPin: 0, setPin: 0 };
  return {
    calls,
    issuer: {
      ...inner,
      revealCredentials: async (input) => {
        calls.revealCredentials += 1;
        return inner.revealCredentials!(input);
      },
      revealPin: async (input) => {
        calls.revealPin += 1;
        return inner.revealPin!(input);
      },
      setPin: async (input) => {
        calls.setPin += 1;
        await inner.setPin!(input);
      },
    },
  };
}

describe('cards.procedures (source)', () => {
  it('is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

/** Shared factory Postgres names the database `test`, which the harness refuses. */
function testAdminUrl(envUrl: string): string {
  const parsed = new URL(envUrl);
  const name = parsed.pathname.replace(/^\//, '');
  if (name.endsWith('_test')) return envUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

describe('customer card procedures (PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const envUrl = process.env.TEST_DATABASE_URL?.trim();
    if (envUrl) {
      adminStop = async () => undefined;
      // The shared URL names database `test`. assertTestDatabase only allows a
      // name ending in `_test`. intafaced_test is the same server and role.
      db = await createTestDatabase({ service: 'bank', url: testAdminUrl(envUrl), migrations: MIGRATIONS });
    } else {
      const container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('intafaced_h8a_test')
        .withUsername('intafaced')
        .withPassword('intafaced')
        .start();
      adminStop = async () => {
        await container.stop();
      };
      db = await createTestDatabase({ service: 'bank', url: container.getConnectionUri(), migrations: MIGRATIONS });
    }
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(scopes: Principal['scopes'] = ['bank:read', 'bank:write']): Principal {
    return {
      sub: HOLDER,
      userId: HOLDER,
      sid: SID,
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
  }

  function caller(bank: BankServices, scopes?: Principal['scopes'], stepUp?: ReturnType<typeof createStepUpGate>) {
    const p = principal(scopes);
    const raw = encodePrincipal(p);
    return createBankRouter(bank, {
      approvals: stubApprovalConsumer(CONFIRM),
      ...(stepUp ? { stepUp } : {}),
    }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  async function freshSim() {
    await sql`TRUNCATE bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { live: false }), clock: () => NOW },
    });
    return { ledger, bank, user: caller(bank), ops: caller(bank, ['admin:treasury']) };
  }

  async function fund(ledger: MemoryLedger, value: string) {
    await ledger.post(recipes.deposit({ userId: HOLDER, assetId: 'USDT', amount: amt(value), rail: 'test', railRef: randomUUID() }));
  }

  it('stores exact ceilings, tightens without step-up, and loosens only with step-up', async () => {
    const { bank, user } = await freshSim();
    const cardId = randomUUID();
    const issued = await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '100.50' });
    expect(issued.perAuthorizationLimit).toBe('100.5');
    expect(issued.dailyLimit).toBeNull();
    expect(issued.simulated).toBe(true);

    const tightened = await user.cards.setLimits({
      cardId,
      commandId: randomUUID(),
      perAuthorizationLimit: '40',
      dailyLimit: '80',
      monthlyLimit: '200',
      cashLimit: '30',
    });
    expect(tightened).toMatchObject({ perAuthorizationLimit: '40', dailyLimit: '80', monthlyLimit: '200', cashLimit: '30' });

    const identity = new FakeIdentity();
    const gated = caller(bank, ['bank:read', 'bank:write'], createStepUpGate({ mode: 'required', approvals: identity, clock: () => NOW }));
    const again = randomUUID();
    await expect(gated.cards.setLimits({ cardId, commandId: again, perAuthorizationLimit: '40', dailyLimit: '50' })).resolves.toMatchObject(
      { dailyLimit: '50', perAuthorizationLimit: '40' },
    );
    const loosen = randomUUID();
    await expect(gated.cards.setLimits({ cardId, commandId: loosen, perAuthorizationLimit: '90' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const approval = identity.approve('bank.step_up.cards.setLimits', {
      actor: HOLDER,
      cardId,
      commandId: loosen,
      perAuthorizationLimit: '90',
      dailyLimit: '',
      monthlyLimit: '',
      cashLimit: '',
    });
    const raised = await gated.cards.setLimits({ cardId, commandId: loosen, perAuthorizationLimit: '90', stepUpApprovalId: approval });
    expect(raised.perAuthorizationLimit).toBe('90');
    expect(raised.dailyLimit).toBe('50');
    const listed = await user.cards.list({ limit: 10 });
    expect(listed[0]).toMatchObject({ id: cardId, perAuthorizationLimit: '90', dailyLimit: '50', monthlyLimit: '200', cashLimit: '30' });
  });

  it('replays a limits command and refuses the same id with different ceilings', async () => {
    const { user } = await freshSim();
    const cardId = randomUUID();
    const commandId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '100' });
    await user.cards.setLimits({ cardId, commandId, perAuthorizationLimit: '70', dailyLimit: '70' });
    const replay = await user.cards.setLimits({ cardId, commandId, perAuthorizationLimit: '70', dailyLimit: '70' });
    expect(replay.perAuthorizationLimit).toBe('70');
    await expect(user.cards.setLimits({ cardId, commandId, perAuthorizationLimit: '10' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_command_conflict'),
    });
    expect((await user.cards.list({ limit: 10 }))[0]?.perAuthorizationLimit).toBe('70');
  });

  it('returns channel flags and declines a purchase on a switched-off channel', async () => {
    const { ledger, user, ops } = await freshSim();
    await fund(ledger, '500');
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '400' });
    const commandId = randomUUID();
    const switched = await user.cards.setChannels({ cardId, commandId, online: false, contactless: true, atm: false, abroad: true });
    expect(switched).toMatchObject({ online: false, contactless: true, atm: false, abroad: true, simulated: true });
    expect((await user.cards.list({ limit: 10 }))[0]).toMatchObject({ online: false, atm: false });

    const online = await ops.ops.cardAuthorize({
      cardId,
      authorizationRef: 'auth-online',
      amount: '10',
      channel: 'online',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(online).toMatchObject({ decision: 'declined', declineCode: 'bank.card_channel_off' });

    const present = await ops.ops.cardAuthorize({
      cardId,
      authorizationRef: 'auth-present',
      amount: '10',
      channel: 'card-present',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(present).toMatchObject({ decision: 'approved', declineCode: null });

    await user.cards.setLimits({ cardId, commandId: randomUUID(), perAuthorizationLimit: '400', dailyLimit: '15' });
    const overDay = await ops.ops.cardAuthorize({
      cardId,
      authorizationRef: 'auth-day',
      amount: '10',
      channel: 'card-present',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(overDay).toMatchObject({ decision: 'declined', declineCode: 'bank.card_daily_limit_exceeded' });

    await user.cards.setChannels({ cardId, commandId: randomUUID(), online: false, contactless: true, atm: true, abroad: true });
    await user.cards.setLimits({ cardId, commandId: randomUUID(), perAuthorizationLimit: '400', dailyLimit: '100', cashLimit: '5' });
    const cash = await ops.ops.cardAuthorize({
      cardId,
      authorizationRef: 'auth-atm',
      amount: '6',
      channel: 'atm',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(cash).toMatchObject({ decision: 'declined', declineCode: 'bank.card_cash_limit_exceeded' });
  });

  it('refuses PAN, PIN and wallet on the simulated programme and stores neither secret', async () => {
    const { user } = await freshSim();
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '100' });
    await expect(user.cards.reveal({ cardId, revealId: randomUUID() })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_pan_issuer_unset'),
    });
    await expect(user.cards.pin.reveal({ cardId, revealId: randomUUID() })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_pin_issuer_unset'),
    });
    await expect(user.cards.pin.set({ cardId, commandId: randomUUID(), pin: PIN })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_pin_issuer_unset'),
    });
    await expect(
      user.cards.walletProvision({ cardId, provisionId: randomUUID(), wallet: 'apple', nonce: 'nonce-1' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_wallet_issuer_unset'),
    });
    await expect(user.cards.rewards()).rejects.toMatchObject({ message: expect.stringContaining('bank.rewards_issuer_unset') });
    const dump = JSON.stringify(await sql`SELECT * FROM bank.cards`);
    const audits = JSON.stringify(await sql`SELECT * FROM bank.card_secret_audits`);
    expect(dump).not.toContain(PAN);
    expect(dump).not.toContain(PIN);
    expect(audits).not.toContain(PIN);
    expect(audits).toBe('[]');
  });

  it('refuses PAN, PIN reveal and PIN set when step-up is not switched on', async () => {
    await sql`TRUNCATE bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const { issuer, calls } = countingLiveIssuer();
    const cards = new CardService(sql, ledger, { issuer, clock: () => NOW });
    const bank = { cards } as unknown as BankServices;
    const user = caller(bank, ['bank:read', 'bank:write']);
    await sql.unsafe(SIMULATED_DOWN);
    try {
      const cardId = randomUUID();
      await cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
      await expect(user.cards.reveal({ cardId, revealId: randomUUID() })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_unavailable'),
      });
      await expect(user.cards.pin.reveal({ cardId, revealId: randomUUID() })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_unavailable'),
      });
      await expect(user.cards.pin.set({ cardId, commandId: randomUUID(), pin: PIN })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_unavailable'),
      });
      expect(calls).toEqual({ revealCredentials: 0, revealPin: 0, setPin: 0 });
      const counted = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM bank.card_secret_audits`;
      expect(counted[0]?.count).toBe('0');
    } finally {
      await sql.unsafe(SIMULATED_UP);
    }
  });

  it('returns a live issuer secret once, audits the reveal, and does not store the secret', async () => {
    await sql`TRUNCATE bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const cards = new CardService(sql, ledger, { issuer: liveIssuer(), clock: () => NOW });
    const bank = { cards } as unknown as BankServices;
    const identity = new FakeIdentity();
    const user = caller(bank, ['bank:read', 'bank:write'], createStepUpGate({ mode: 'required', approvals: identity, clock: () => NOW }));
    await sql.unsafe(SIMULATED_DOWN);
    try {
      const cardId = randomUUID();
      const revealId = randomUUID();
      await cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
      await expect(user.cards.reveal({ cardId, revealId })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_required'),
      });
      const approval = identity.approve('bank.step_up.cards.reveal', { actor: HOLDER, cardId, revealId });
      const revealed = await user.cards.reveal({ cardId, revealId, stepUpApprovalId: approval });
      expect(revealed).toEqual({ pan: PAN, expiry: '12/30', cvv: CVV, expiresAt: '2026-06-15T12:01:00.000Z' });
      await expect(user.cards.reveal({ cardId, revealId, stepUpApprovalId: approval })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_used'),
      });
      const pinId = randomUUID();
      const pinApproval = identity.approve('bank.step_up.cards.pinSet', { actor: HOLDER, cardId, commandId: pinId });
      await expect(user.cards.pin.set({ cardId, commandId: pinId, pin: '12', stepUpApprovalId: pinApproval })).rejects.toMatchObject({
        message: expect.stringContaining('bank.card_pin_invalid'),
      });
      const pinOk = randomUUID();
      const pinOkApproval = identity.approve('bank.step_up.cards.pinSet', { actor: HOLDER, cardId, commandId: pinOk });
      await expect(user.cards.pin.set({ cardId, commandId: pinOk, pin: PIN, stepUpApprovalId: pinOkApproval })).resolves.toEqual({
        ok: true,
      });
      const pinView = randomUUID();
      const pinViewApproval = identity.approve('bank.step_up.cards.pinReveal', { actor: HOLDER, cardId, revealId: pinView });
      await expect(user.cards.pin.reveal({ cardId, revealId: pinView, stepUpApprovalId: pinViewApproval })).resolves.toEqual({
        pin: PIN,
        expiresAt: '2026-06-15T12:01:00.000Z',
      });
      const provisionId = randomUUID();
      await expect(user.cards.walletProvision({ cardId, provisionId, wallet: 'google', nonce: 'device-nonce' })).resolves.toEqual({
        payload: WALLET_PAYLOAD,
        expiresAt: '2026-06-15T12:01:00.000Z',
      });
      const stored = JSON.stringify(await sql`SELECT id, user_id, asset_id, pan_tail, card_type, shipping_address FROM bank.cards`);
      const audits = await sql<Array<{ kind: string; payload_hash: string }>>`
        SELECT kind, payload_hash FROM bank.card_secret_audits ORDER BY kind
      `;
      expect(stored).not.toContain(PAN);
      expect(stored).not.toContain(CVV);
      expect(stored).not.toContain(PIN);
      expect(stored).not.toContain(WALLET_PAYLOAD);
      expect(audits.map((row) => row.kind).sort()).toEqual(['pan_reveal', 'pin_reveal', 'pin_set', 'wallet_provision']);
      expect(JSON.stringify(audits)).not.toContain(PAN);
      expect(JSON.stringify(audits)).not.toContain(PIN);
      expect(JSON.stringify(audits)).not.toContain(WALLET_PAYLOAD);
    } finally {
      await sql.unsafe(SIMULATED_UP);
    }
  });

  it('issues a simulated physical card only with a delivery address', async () => {
    const { user } = await freshSim();
    const missing = randomUUID();
    await expect(
      user.cards.issue({ cardId: missing, assetId: 'USDT', perAuthorizationLimit: '25', cardType: 'physical' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_shipping_address_required'),
    });
    const cardId = randomUUID();
    const issued = await user.cards.issue({
      cardId,
      assetId: 'USDT',
      perAuthorizationLimit: '25',
      cardType: 'physical',
      shippingAddress: ADDRESS,
    });
    expect(issued).toMatchObject({
      cardType: 'physical',
      simulated: true,
      issuer: 'card-sim',
      shippingAddress: { ...ADDRESS, line2: null, region: null },
    });
    const same = await user.cards.issue({
      cardId,
      assetId: 'USDT',
      perAuthorizationLimit: '25',
      cardType: 'physical',
      shippingAddress: ADDRESS,
    });
    expect(same.id).toBe(cardId);
    await expect(
      user.cards.issue({
        cardId,
        assetId: 'USDT',
        perAuthorizationLimit: '25',
        cardType: 'virtual',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.card_issue_conflict') });
  });

  it('replaces a card and keeps the asset, ceilings and channels', async () => {
    const { user } = await freshSim();
    const cardId = randomUUID();
    const replacementId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '100' });
    await user.cards.setLimits({ cardId, commandId: randomUUID(), perAuthorizationLimit: '100', dailyLimit: '60', cashLimit: '20' });
    await user.cards.setChannels({ cardId, commandId: randomUUID(), online: true, contactless: false, atm: true, abroad: false });
    const replaced = await user.cards.replace({ cardId, replacementId, reason: 'stolen' });
    expect(replaced).toMatchObject({
      id: replacementId,
      assetId: 'USDT',
      perAuthorizationLimit: '100',
      dailyLimit: '60',
      cashLimit: '20',
      online: true,
      contactless: false,
      atm: true,
      abroad: false,
      simulated: true,
      status: 'active',
    });
    expect(replaced.panTail).toMatch(/^\d{4}$/);
    const again = await user.cards.replace({ cardId, replacementId, reason: 'stolen' });
    expect(again.id).toBe(replacementId);
    const rows = await user.cards.list({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === cardId)).toMatchObject({ status: 'closed' });
    await expect(user.cards.replace({ cardId, replacementId: randomUUID(), reason: 'lost' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_replace_conflict'),
    });
  });

  it('returns the settled cashback figure once a non-simulated issuer has paid it', async () => {
    await sql`TRUNCATE bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const cards = new CardService(sql, ledger, { issuer: liveIssuer(), clock: () => NOW });
    const bank = { cards } as unknown as BankServices;
    const user = caller(bank);
    await sql.unsafe(SIMULATED_DOWN);
    try {
      await expect(user.cards.rewards()).rejects.toMatchObject({ message: expect.stringContaining('bank.rewards_issuer_unset') });
      const card = await cards.issue({
        cardId: randomUUID(),
        userId: HOLDER,
        assetId: 'USDT',
        cashbackBps: 100,
        perAuthorizationLimit: amt('1000'),
      });
      expect(card.simulated).toBe(false);
      await ledger.post(recipes.deposit({ userId: HOLDER, assetId: 'USDT', amount: amt('500'), rail: 'test', railRef: randomUUID() }));
      await ledger.post(recipes.deposit({ userId: FEE_PAYER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: randomUUID() }));
      await ledger.post(
        recipes.feeCharge({
          chargeId: `bank:${randomUUID()}`,
          userId: FEE_PAYER,
          module: 'bank',
          mode: 'asset',
          assetId: 'USDT',
          amount: amt('10'),
        }),
      );
      await cards.fundCashbackPot({ windowId: `w:${randomUUID()}`, assetId: 'USDT', amount: amt('10') });
      await cards.authorize({ cardId: card.id, authorizationRef: 'auth-reward', amount: amt('100') });
      const captured = await cards.capture({ cardId: card.id, authorizationRef: 'auth-reward', amount: amt('100') });
      expect(captured.cashback).toMatchObject({ status: 'paid', amount: amt('1') });
      await expect(user.cards.rewards()).resolves.toEqual({ balance: '1', asset: 'USDT', simulated: false });
      expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount >= amt('1')).toBe(true);
    } finally {
      await sql.unsafe(SIMULATED_UP);
    }
  });
});
