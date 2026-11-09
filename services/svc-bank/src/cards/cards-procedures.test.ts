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
import { NOTHING_REPORTED } from './partner-terms.js';

function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
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
    await sql`TRUNCATE bank.card_controls, bank.card_status_events, bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
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

  it('blocks a category, a merchant and a country (J-bank-14 #1): each declines with its own code before anything is held, and a lifted block lets the next purchase through', async () => {
    const { ledger, user, ops } = await freshSim();
    await fund(ledger, '500');
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '400' });
    const buy = (ref: string, at: { merchantCategory?: string; merchant?: string; merchantCountry?: string }) =>
      ops.ops.cardAuthorize({ cardId, authorizationRef: ref, amount: '10', ...at, confirmOperatorId: CONFIRM, ...APPROVAL });

    const read = await user.cards.controls.get({ cardId });
    expect(read).toEqual({
      categories: ['gambling', 'cash_like', 'adult', 'travel', 'entertainment', 'online_shopping', 'groceries', 'fuel'],
      controls: [],
      history: [],
    });
    await user.cards.controls.block({ cardId, kind: 'category', value: 'gambling' });
    // Blocking again is the same control, never a second row.
    await user.cards.controls.block({ cardId, kind: 'category', value: 'gambling' });
    await user.cards.controls.block({ cardId, kind: 'merchant', value: '  TEST Casino Shop ' });
    const blocked = await user.cards.controls.block({ cardId, kind: 'country', value: 'us' });
    expect(blocked.controls.map((c) => [c.kind, c.value])).toEqual([
      ['category', 'gambling'],
      ['merchant', 'test casino shop'],
      ['country', 'US'],
    ]);

    const available = (await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount;
    expect(await buy('ctl-category', { merchantCategory: 'gambling' })).toMatchObject({
      decision: 'declined',
      declineCode: 'bank.card_category_blocked',
    });
    expect(await buy('ctl-merchant', { merchant: 'test CASINO shop' })).toMatchObject({
      decision: 'declined',
      declineCode: 'bank.card_merchant_blocked',
    });
    expect(await buy('ctl-country', { merchantCountry: 'US' })).toMatchObject({
      decision: 'declined',
      declineCode: 'bank.card_country_blocked',
    });
    // Nothing was held for any of them.
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(available);
    const feed = await user.cards.authorizations({ cardId, limit: 10 });
    expect(feed.find((row) => row.authorizationRef === 'ctl-merchant')).toMatchObject({
      merchant: 'test CASINO shop',
      merchantCountry: null,
      status: 'rejected',
    });
    expect(feed.find((row) => row.authorizationRef === 'ctl-country')).toMatchObject({ merchantCountry: 'US' });

    // A purchase the controls don't name goes through; a lifted block no longer declines.
    expect(await buy('ctl-other', { merchantCategory: 'groceries', merchant: 'TEST Grocer', merchantCountry: 'DE' })).toMatchObject({
      decision: 'approved',
    });
    const gambling = blocked.controls.find((c) => c.kind === 'category')!;
    const lifted = await user.cards.controls.lift({ cardId, controlId: gambling.id });
    expect(lifted.controls.map((c) => c.kind)).toEqual(['merchant', 'country']);
    expect(await buy('ctl-after-lift', { merchantCategory: 'gambling' })).toMatchObject({ decision: 'approved' });
    await expect(user.cards.controls.lift({ cardId, controlId: randomUUID() })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_control_not_found'),
    });
  });

  it('refuses a control it cannot keep, and records each lock and unlock in the card history (J-bank-14 #1)', async () => {
    const { user } = await freshSim();
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '50' });
    for (const [kind, value] of [
      ['category', 'casinos'],
      ['country', 'USA'],
      ['merchant', 'a'.repeat(65)],
    ] as const)
      await expect(user.cards.controls.block({ cardId, kind, value })).rejects.toThrow();
    await expect(user.cards.controls.block({ cardId, kind: 'country', value: 'U1' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_control_invalid'),
    });
    expect((await user.cards.controls.get({ cardId })).controls).toEqual([]);

    await user.cards.setStatus({ cardId, status: 'frozen' });
    // Freezing a frozen card changes nothing, so it adds no history.
    await user.cards.setStatus({ cardId, status: 'frozen' });
    await user.cards.setStatus({ cardId, status: 'active' });
    const { history } = await user.cards.controls.get({ cardId });
    expect(history.map((h) => [h.status, h.actor])).toEqual([
      ['active', 'owner'],
      ['frozen', 'owner'],
    ]);
  });

  it("never shows or changes another person's card controls", async () => {
    const { bank, user } = await freshSim();
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '50' });
    const other = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: (() => {
          const raw = encodePrincipal({ ...principal(), sub: FEE_PAYER, userId: FEE_PAYER } as Principal);
          return {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          };
        })(),
        id: `req-${randomUUID()}`,
      }),
    );
    await expect(other.cards.controls.get({ cardId })).rejects.toThrow();
    await expect(other.cards.controls.block({ cardId, kind: 'category', value: 'gambling' })).rejects.toThrow();
    expect((await user.cards.controls.get({ cardId })).controls).toEqual([]);
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
      expect(revealed).toEqual({ pan: PAN, expiry: '12/30', cvv: CVV, expiresAt: '2026-06-15T12:01:00.000Z', test: false });
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
        test: false,
      });
      const provisionId = randomUUID();
      await expect(user.cards.walletProvision({ cardId, provisionId, wallet: 'google', nonce: 'device-nonce' })).resolves.toEqual({
        payload: WALLET_PAYLOAD,
        expiresAt: '2026-06-15T12:01:00.000Z',
        test: false,
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

  /** The TEST partner adapter with `secrets: "test"` and the owner's PIN try limit (J-bank-14 #3, #4). */
  async function testSecretsSim(pinTryLimit: number | null, threeDSTryLimit: number | null = null) {
    await sql`TRUNCATE bank.card_3ds_challenges, bank.card_fraud_reports, bank.card_wallet_tokens, bank.card_controls, bank.card_status_events, bank.card_secret_audits, bank.card_commands, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    const partner = { ...NOTHING_REPORTED, secrets: 'test' as const };
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      cards: { issuer: cardIssuerFor('card-sim', { live: false }, partner), clock: () => NOW, pinTryLimit, threeDSTryLimit },
    });
    const identity = new FakeIdentity();
    const gate = createStepUpGate({ mode: 'required', approvals: identity, clock: () => NOW });
    return { ledger, bank, identity, user: caller(bank, ['bank:read', 'bank:write'], gate), ops: caller(bank, ['admin:treasury']) };
  }

  it('shows the TEST partner card details once per step-up, labelled TEST, and keeps none of them', async () => {
    const { bank, user, identity } = await testSecretsSim(3);
    await expect(user.cards.secretsOffered()).resolves.toEqual({ details: true, pin: true, wallet: true, test: true });
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const revealId = randomUUID();
    const approval = identity.approve('bank.step_up.cards.reveal', { actor: HOLDER, cardId, revealId });
    const revealed = await user.cards.reveal({ cardId, revealId, stepUpApprovalId: approval });
    expect(revealed).toMatchObject({ test: true, expiresAt: '2026-06-15T12:01:00.000Z' });
    expect(revealed.pan).toMatch(/^999999\d{10}$/);
    expect(luhnOk(revealed.pan)).toBe(true);
    expect(revealed.expiry).toMatch(/^(0[1-9]|1[0-2])\/3[0-4]$/);
    expect(revealed.cvv).toMatch(/^\d{3}$/);
    // A second reveal is a new reveal id and needs its own step-up; the first approval does not carry over.
    const again = randomUUID();
    await expect(user.cards.reveal({ cardId, revealId: again, stepUpApprovalId: approval })).rejects.toMatchObject({
      message: expect.stringMatching(/bank\.step_up_(used|mismatch|required|invalid)/),
    });
    await expect(user.cards.reveal({ cardId, revealId: again })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const second = await user.cards.reveal({
      cardId,
      revealId: again,
      stepUpApprovalId: identity.approve('bank.step_up.cards.reveal', { actor: HOLDER, cardId, revealId: again }),
    });
    expect(second.pan).toBe(revealed.pan);
    const stored = JSON.stringify(await sql`SELECT * FROM bank.cards`) + JSON.stringify(await sql`SELECT * FROM bank.card_secret_audits`);
    expect(stored).not.toContain(revealed.pan);
  });

  it('sets a TEST PIN and blocks it at the owner count of wrong tries, until a new PIN is set', async () => {
    const { bank, user, identity, ops, ledger } = await testSecretsSim(3);
    await fund(ledger, '100');
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const setPin = async (pin: string) => {
      const commandId = randomUUID();
      return user.cards.pin.set({
        cardId,
        commandId,
        pin,
        stepUpApprovalId: identity.approve('bank.step_up.cards.pinSet', { actor: HOLDER, cardId, commandId }),
      });
    };
    let n = 0;
    const tap = (pin: string) =>
      ops.ops.cardAuthorize({ cardId, authorizationRef: `auth-pin-${++n}`, amount: '1', pin, confirmOperatorId: CONFIRM, ...APPROVAL });

    // No PIN yet: nothing to show, and a typed PIN declines by name.
    const viewId = randomUUID();
    await expect(
      user.cards.pin.reveal({
        cardId,
        revealId: viewId,
        stepUpApprovalId: identity.approve('bank.step_up.cards.pinReveal', { actor: HOLDER, cardId, revealId: viewId }),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.card_pin_not_set') });
    expect(await tap('1234')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_not_set' });

    await expect(setPin('4321')).resolves.toEqual({ ok: true });
    const shown = randomUUID();
    await expect(
      user.cards.pin.reveal({
        cardId,
        revealId: shown,
        stepUpApprovalId: identity.approve('bank.step_up.cards.pinReveal', { actor: HOLDER, cardId, revealId: shown }),
      }),
    ).resolves.toEqual({ pin: '4321', expiresAt: '2026-06-15T12:01:00.000Z', test: true });

    expect(await tap('4321')).toMatchObject({ decision: 'approved' });
    expect(await tap('0000')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_wrong' });
    expect(await tap('0000')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_wrong' });
    expect(await tap('0000')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_blocked' });
    // Blocked: even the right PIN declines now.
    expect(await tap('4321')).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_blocked' });
    // A new PIN clears the wrong tries.
    await setPin('8642');
    expect(await tap('8642')).toMatchObject({ decision: 'approved' });
    // A right PIN between wrong ones starts the count again.
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_wrong' });
    expect(await tap('8642')).toMatchObject({ decision: 'approved' });
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_wrong' });
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_wrong' });
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_blocked' });

    // The same purchase delivered twice at once is one wrong try, not two.
    await setPin('8642');
    const twice = await Promise.all([
      ops.ops.cardAuthorize({
        cardId,
        authorizationRef: 'auth-pin-twice',
        amount: '1',
        pin: '0000',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
      ops.ops.cardAuthorize({
        cardId,
        authorizationRef: 'auth-pin-twice',
        amount: '1',
        pin: '0000',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ]);
    expect(twice.map((d) => d.declineCode)).toEqual(['bank.card_pin_wrong', 'bank.card_pin_wrong']);
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_wrong' });
    expect(await tap('0000')).toMatchObject({ declineCode: 'bank.card_pin_blocked' });

    const stored =
      JSON.stringify(await sql`SELECT * FROM bank.card_authorizations`) + JSON.stringify(await sql`SELECT * FROM bank.card_secret_audits`);
    expect(stored).not.toContain('4321');
    expect(stored).not.toContain('8642');
  });

  it('declines a typed PIN by name while the owner has not set the try limit', async () => {
    const { bank, user, identity, ops, ledger } = await testSecretsSim(null);
    await fund(ledger, '10');
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const commandId = randomUUID();
    await user.cards.pin.set({
      cardId,
      commandId,
      pin: '4321',
      stepUpApprovalId: identity.approve('bank.step_up.cards.pinSet', { actor: HOLDER, cardId, commandId }),
    });
    const tapped = await ops.ops.cardAuthorize({
      cardId,
      authorizationRef: 'auth-no-limit',
      amount: '1',
      pin: '4321',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    expect(tapped).toMatchObject({ decision: 'declined', declineCode: 'bank.card_pin_try_limit_unset' });
    await expect(ledger.balance(userAvailable(HOLDER, 'USDT'))).resolves.toMatchObject({ amount: amt('10') });
  });

  it('adds the card to a phone wallet once per wallet, shows its tokens paused while frozen, and adds none to a frozen card', async () => {
    const { bank, user } = await testSecretsSim(3);
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const first = await user.cards.walletProvision({ cardId, provisionId: randomUUID(), wallet: 'apple', nonce: 'device-a' });
    expect(first).toMatchObject({ test: true });
    expect(first.payload).toMatch(/^TEST-wallet-apple-/);
    // The same card into the same wallet again is the same token.
    await user.cards.walletProvision({ cardId, provisionId: randomUUID(), wallet: 'apple', nonce: 'device-b' });
    const added = await user.cards.walletTokens({ cardId });
    expect(added.test).toBe(true);
    expect(added.tokens).toHaveLength(1);
    expect(added.tokens[0]).toMatchObject({ wallet: 'apple', state: 'added' });

    await user.cards.setStatus({ cardId, status: 'frozen' });
    expect((await user.cards.walletTokens({ cardId })).tokens).toEqual([expect.objectContaining({ wallet: 'apple', state: 'paused' })]);
    await expect(
      user.cards.walletProvision({ cardId, provisionId: randomUUID(), wallet: 'google', nonce: 'device-c' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('bank.card_not_active') });
    expect((await user.cards.walletTokens({ cardId })).tokens).toHaveLength(1);
    const rows = JSON.stringify(await sql`SELECT * FROM bank.card_wallet_tokens`);
    expect(rows).not.toContain(first.payload);
  });

  it('completes a 3D Secure purchase once on the right code, and locks a challenge at the owner count of wrong codes (J-bank-14 #5)', async () => {
    const { bank, user, ops, ledger } = await testSecretsSim(3, 3);
    await fund(ledger, '100');
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const challenge = async (ref: string, amount = '7') =>
      ops.ops.cardThreeDSChallenge({
        cardId,
        challengeId: randomUUID(),
        challengeRef: ref,
        amount,
        merchant: 'Online shop',
        merchantCountry: 'de',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });

    const opened = await challenge('3ds-ok');
    expect(opened.state).toBe('open');
    // The same reference again is the same challenge; with a different amount it refuses and changes nothing.
    expect((await challenge('3ds-ok')).challengeId).toBe(opened.challengeId);
    await expect(challenge('3ds-ok', '8')).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'bank.card_3ds_conflict' }) });

    const [listed] = (await user.cards.threeDS.list({ cardId })).challenges;
    expect(listed).toMatchObject({
      id: opened.challengeId,
      state: 'open',
      triesLeft: 3,
      amount: '7',
      merchant: 'Online shop',
      merchantCountry: 'DE',
    });
    expect(listed!.testCode).toMatch(/^\d{6}$/);
    const right = listed!.testCode!;
    const wrong = right === '000000' ? '111111' : '000000';

    const once = await user.cards.threeDS.answer({ cardId, challengeId: opened.challengeId, code: wrong });
    expect(once).toMatchObject({ state: 'open', triesLeft: 2, authorizationId: null });
    const approved = await user.cards.threeDS.answer({ cardId, challengeId: opened.challengeId, code: right });
    expect(approved.state).toBe('approved');
    expect(approved.testCode).toBeNull();
    // Answered again, or at once by two answers, it is the same one authorisation and one hold.
    const [again, racing] = await Promise.all([
      user.cards.threeDS.answer({ cardId, challengeId: opened.challengeId, code: right }),
      user.cards.threeDS.answer({ cardId, challengeId: opened.challengeId, code: wrong }),
    ]);
    expect(again.authorizationId).toBe(approved.authorizationId);
    expect(racing.authorizationId).toBe(approved.authorizationId);
    const auths = await bank.cards.authorizationsOf(cardId, 50);
    expect(auths).toHaveLength(1);
    expect(auths[0]).toMatchObject({
      id: approved.authorizationId,
      decision: 'approved',
      authorizationRef: '3ds:3ds-ok',
      channel: 'online',
    });
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount.toString()).toBe(amt('93').toString());

    // Three wrong codes lock the next challenge: no authorisation, and the right code no longer helps.
    const locked = await challenge('3ds-locked');
    const code = (await user.cards.threeDS.list({ cardId })).challenges.find((c) => c.id === locked.challengeId)!.testCode!;
    const bad = code === '000000' ? '111111' : '000000';
    expect(await user.cards.threeDS.answer({ cardId, challengeId: locked.challengeId, code: bad })).toMatchObject({
      state: 'open',
      triesLeft: 2,
    });
    expect(await user.cards.threeDS.answer({ cardId, challengeId: locked.challengeId, code: bad })).toMatchObject({
      state: 'open',
      triesLeft: 1,
    });
    expect(await user.cards.threeDS.answer({ cardId, challengeId: locked.challengeId, code: bad })).toMatchObject({
      state: 'locked',
      triesLeft: 0,
    });
    expect(await user.cards.threeDS.answer({ cardId, challengeId: locked.challengeId, code })).toMatchObject({
      state: 'locked',
      authorizationId: null,
      testCode: null,
    });
    expect(await bank.cards.authorizationsOf(cardId, 50)).toHaveLength(1);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount.toString()).toBe(amt('93').toString());
    // The code is never kept.
    expect(JSON.stringify(await sql`SELECT * FROM bank.card_3ds_challenges`)).not.toContain(code);
  });

  it('finishes an approved 3D Secure challenge whose authorisation was never written, and refuses by name without the owner count or a partner (J-bank-14 #5)', async () => {
    const { bank, user, ops, ledger } = await testSecretsSim(3, 3);
    await fund(ledger, '100');
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const opened = await ops.ops.cardThreeDSChallenge({
      cardId,
      challengeId: randomUUID(),
      challengeRef: '3ds-crash',
      amount: '5',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    // A crash between the approval and the authorisation: the row says approved and holds no authorisation.
    await sql`UPDATE bank.card_3ds_challenges SET state = 'approved' WHERE id = ${opened.challengeId}`;
    expect(await bank.cards.authorizationsOf(cardId, 50)).toHaveLength(0);
    const finished = await user.cards.threeDS.answer({ cardId, challengeId: opened.challengeId, code: '000000' });
    expect(finished.state).toBe('approved');
    expect(finished.authorizationId).not.toBeNull();
    expect(await bank.cards.authorizationsOf(cardId, 50)).toHaveLength(1);

    // The owner has not set the count: answering refuses by name, and nothing is counted.
    const unset = await testSecretsSim(3, null);
    const card2 = randomUUID();
    await unset.bank.cards.issue({ cardId: card2, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const open2 = await unset.ops.ops.cardThreeDSChallenge({
      cardId: card2,
      challengeId: randomUUID(),
      challengeRef: '3ds-unset',
      amount: '5',
      confirmOperatorId: CONFIRM,
      ...APPROVAL,
    });
    await expect(unset.user.cards.threeDS.answer({ cardId: card2, challengeId: open2.challengeId, code: '000000' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.card_3ds_try_limit_unset' }),
    });
    expect((await unset.user.cards.threeDS.list({ cardId: card2 })).challenges[0]).toMatchObject({ state: 'open' });

    // card-sim without the TEST secrets switch has no partner to send a code: the issuer's request refuses by name.
    const { bank: plain, ops: plainOps } = await freshSim();
    const card3 = randomUUID();
    await plain.cards.issue({ cardId: card3, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    await expect(
      plainOps.ops.cardThreeDSChallenge({
        cardId: card3,
        challengeId: randomUUID(),
        challengeRef: '3ds-none',
        amount: '5',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'bank.card_3ds_issuer_unset' }) });
  });

  it('reports fraud on a card payment: the card freezes, one case opens per payment, and another person cannot report it (J-bank-14 #7)', async () => {
    const { bank, user, ops, ledger } = await testSecretsSim(3, 3);
    await fund(ledger, '100');
    const cardId = randomUUID();
    await bank.cards.issue({ cardId, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    const paid = await ops.ops.cardAuthorize({ cardId, authorizationRef: 'fraud-1', amount: '4', confirmOperatorId: CONFIRM, ...APPROVAL });
    const before = (await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount.toString();

    const report = await user.cards.fraud.report({ cardId, authorizationId: paid.authorizationId, reportId: randomUUID() });
    expect(report).toMatchObject({ cardId, authorizationId: paid.authorizationId, state: 'open' });
    expect((await bank.cards.card(cardId)).status).toBe('frozen');
    // The same payment again is the same case.
    const again = await user.cards.fraud.report({ cardId, authorizationId: paid.authorizationId, reportId: randomUUID() });
    expect(again.id).toBe(report.id);
    expect((await user.cards.fraud.list({ cardId })).reports).toHaveLength(1);
    // Nothing moved.
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount.toString()).toBe(before);
    // A frozen card declines the next purchase.
    expect(
      await ops.ops.cardAuthorize({ cardId, authorizationRef: 'fraud-2', amount: '1', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).toMatchObject({
      decision: 'declined',
    });

    // A payment on another card is not this card's to report.
    const other = randomUUID();
    await bank.cards.issue({ cardId: other, userId: HOLDER, assetId: 'USDT', perAuthorizationLimit: amt('100') });
    await expect(
      user.cards.fraud.report({ cardId: other, authorizationId: paid.authorizationId, reportId: randomUUID() }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.card_authorization_not_found' }),
    });
    // Another person's card is not found.
    const stranger = randomUUID();
    await bank.cards.issue({
      cardId: stranger,
      userId: '33333333-3333-4333-8333-333333333333',
      assetId: 'USDT',
      perAuthorizationLimit: amt('100'),
    });
    await expect(
      user.cards.fraud.report({ cardId: stranger, authorizationId: paid.authorizationId, reportId: randomUUID() }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.card_not_found' }),
    });
    await expect(user.cards.threeDS.list({ cardId: stranger })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.card_not_found' }),
    });
  });

  it('keeps card-sim without `secrets` refusing card details, PIN and wallet by name', async () => {
    const { user } = await freshSim();
    const cardId = randomUUID();
    await user.cards.issue({ cardId, assetId: 'USDT', perAuthorizationLimit: '100' });
    await expect(user.cards.walletProvision({ cardId, provisionId: randomUUID(), wallet: 'apple', nonce: 'n' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.card_wallet_issuer_unset'),
    });
    await expect(user.cards.walletTokens({ cardId })).resolves.toEqual({ test: false, tokens: [] });
    await expect(user.cards.secretsOffered()).resolves.toEqual({ details: false, pin: false, wallet: false, test: false });
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
