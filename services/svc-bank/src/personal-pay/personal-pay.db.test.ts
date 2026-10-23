/**
 * Bill pay and global send. Acceptance tests enter through the router.
 * TEST_DATABASE_URL only. This file does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { MemoryLedger, parseAmount, railBoundary, recipes, userAvailable } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { createStepUpGate } from '../step-up/step-up-gate.js';
import type { BillPorts, GlobalPorts } from './ports.js';
import { GLOBAL_SIM_RAIL, globalSimPorts, parseGlobalSim } from './global-sim.js';
import { billPayStepUp } from './step-up-fields.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SID = '77777777-7777-4777-8777-777777777777';
const QUOTE = {
  rate: '7.25',
  fee: '1.10',
  feeAsset: 'USDT',
  receiveAmount: '71.41',
  validUntil: '2099-01-01T00:00:00.000Z',
  eta: '2099-01-02T00:00:00.000Z',
};

function principal(userId: string, scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[], stepUp?: ReturnType<typeof createStepUpGate>) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, stepUp ? { stepUp } : {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

function approvingIdentity() {
  const rows = new Map<string, { hash: string; userId: string; actionType: string }>();
  return {
    approve(actionType: string, fields: Record<string, string>, userId: string) {
      const id = randomUUID();
      rows.set(id, { hash: bankActionPayloadHash(actionType, fields), userId, actionType });
      return id;
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      const refuse = (code: string): never => {
        throw new ActionApprovalConsumeError(`refused [action_approval.${code}]`, 'action_approval.consume_failed');
      };
      if (!row || row.hash !== input.payloadHash || row.actionType !== input.targetId) return refuse('payload_mismatch');
      if (row.userId !== input.principalUserId || input.principalSessionId !== SID) return refuse('not_requester');
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: row.actionType,
        targetService: 'svc-bank',
        targetId: input.targetId,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: row.userId,
        approverId: row.userId,
        policyVersion: 'step-up-v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.approvalId,
        kind: 'same_person',
      };
    },
  };
}

function liveBills(submit: BillPorts['rail']['submit']): BillPorts {
  return {
    directory: {
      status: () => 'live',
      async search() {
        return [{ id: 'power-de', name: 'TEST POWER', country: 'DE', category: 'utility' }];
      },
    },
    lookup: {
      status: () => 'live',
      async lookup(input) {
        if (input.reference === 'unknown') return null;
        return { amountDue: '25.00', dueDate: '2026-11-01', payeeName: 'TEST POWER', currency: 'EUR' };
      },
    },
    rail: { status: () => 'live', railId: () => 'test-bill-rail', submit },
  };
}

function liveGlobal(over: Partial<GlobalPorts> = {}): GlobalPorts {
  return {
    corridors: {
      status: () => 'live',
      async list() {
        return [
          {
            country: 'DE',
            currency: 'EUR',
            deliveryMethods: ['bank'],
            minAmount: '1.00',
            maxAmount: null,
            cutOffTime: '16:00 Europe/Berlin',
          },
          // TEST corridor so the purpose rule can be reached for a currency the owner's table names.
          {
            country: 'DE',
            currency: 'INR',
            deliveryMethods: ['bank'],
            minAmount: '1.00',
            maxAmount: null,
            cutOffTime: '16:00 Europe/Berlin',
          },
        ];
      },
    },
    bic: {
      status: () => 'live',
      async lookup(bic) {
        return bic === 'DEUTDEFF' ? { bic, bankName: 'TEST BANK' } : null;
      },
    },
    fx: {
      status: () => 'live',
      async quote() {
        return QUOTE;
      },
    },
    payout: {
      status: () => 'live',
      railId: () => 'test-payout-rail',
      async submit() {
        return { ok: true, providerRef: 'payout-1', status: 'sent' };
      },
    },
    travelRule: { decision: () => ({ decidedBy: 'test-fixture', requiredFields: ['originatorName'] }) },
    ...over,
  };
}

function transfers(ledger: MemoryLedger) {
  return ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual');
}

const RULES = JSON.stringify({
  reference: [
    { deliveryMethod: 'bank', maxLength: 18 },
    { deliveryMethod: 'bank', country: 'DE', maxLength: 12 },
  ],
  purposeRequired: ['INR'],
  sourceOfFunds: [{ asset: 'USDT', threshold: '50' }],
});

const PAYEE_OK = JSON.stringify({ blockedAccounts: [] });
const ALLOWANCE_NONE = JSON.stringify({ exchangeAccounts: [], windowDays: 30, limits: [] });
const PROOF_LIMITS = JSON.stringify({ allowedTypes: ['application/pdf'], maxBytes: 64 });
const OP_A = '33333333-3333-4333-8333-333333333333';
const OP_B = '44444444-4444-4444-8444-444444444444';
const compliance = ['admin:read', 'admin:compliance'];

describe('personal bill pay and global send', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.bill_recurring_firings, bank.bill_payments, bank.bill_recurring,
               bank.global_incoming_links, bank.global_send_holds,
               bank.global_sends, bank.global_recipients, bank.spaces
      RESTART IDENTITY CASCADE
    `;
  });

  function mount(
    options: {
      bills?: BillPorts;
      global?: GlobalPorts;
      sendFieldRules?: string;
      payeeControls?: string | null;
      exchangeAllowance?: string | null;
      proofLimits?: string;
    } = {},
  ) {
    const ledger = new MemoryLedger();
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      bills: options.bills,
      global: options.global,
      sendFieldRules: options.sendFieldRules,
      payeeControls: options.payeeControls === null ? undefined : (options.payeeControls ?? PAYEE_OK),
      exchangeAllowance: options.exchangeAllowance === null ? undefined : (options.exchangeAllowance ?? ALLOWANCE_NONE),
      proofLimits: options.proofLimits,
    });
    return { ledger, bank };
  }

  async function funded(bank: BankServices, ledger: MemoryLedger, userId = USER) {
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }));
    return bank.spaces.ensurePrimary(userId, 'USDT');
  }

  const read = ['bank:read'];
  const write = ['bank:read', 'bank:write'];

  it('refuses biller search, lookup and pay while the PSP port is unset, and a retry does not post', async () => {
    const { ledger, bank } = mount();
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    await expect(me.bills.billers.search({ query: 'power' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('socket.psp-partners') as unknown as string,
      cause: { code: 'bank.bills_directory_unset', blocker: 'socket.psp-partners' },
    });
    await expect(me.bills.lookup({ billerId: 'power-de', reference: '100' })).rejects.toMatchObject({
      cause: { code: 'bank.bills_lookup_unset', blocker: 'socket.psp-partners' },
    });
    const input = { idempotencyKey: 'bill-key-01', billerId: 'power-de', reference: '100', amount: '10', fromSpaceId: space.id };
    await expect(me.bills.pay(input)).rejects.toMatchObject({
      cause: { code: 'bank.bills_psp_unset', blocker: 'socket.psp-partners' },
    });
    await expect(me.bills.pay(input)).rejects.toMatchObject({ cause: { code: 'bank.bills_psp_unset' } });
    await expect(me.bills.pay({ ...input, amount: '11' })).rejects.toMatchObject({ cause: { code: 'bank.bills_conflict' } });
    const page = await me.bills.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ status: 'failed', amount: '10', ledgerTxId: null, failureCode: 'bank.bills_psp_unset' });
    expect(transfers(ledger)).toHaveLength(0);
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(parseAmount('100'));
    await expect(
      me.bills.recurring.create({
        idempotencyKey: 'recur-key-1',
        billerId: 'power-de',
        reference: '100',
        amount: '10',
        fromSpaceId: space.id,
        cadence: 'monthly',
        startsAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.bills_psp_unset' } });
    expect(await me.bills.recurring.list({ limit: 10 })).toEqual([]);
  });

  it('refuses a session that lacks the scope, including founder counts', async () => {
    const { ledger, bank } = mount();
    const space = await funded(bank, ledger);
    await expect(caller(bank, USER, ['trade:read']).bills.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(bank, USER, ['bank:read']).bills.pay({
        idempotencyKey: 'bill-key-02',
        billerId: 'power-de',
        reference: '100',
        amount: '10',
        fromSpaceId: space.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, USER, ['bank:write']).bills.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, USER, write).bills.ops.summary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(bank, USER, write).bills.runDue({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const founder = await caller(bank, USER, ['admin:read']).bills.ops.summary();
    expect(founder.rails).toEqual({ billerDirectory: 'unset', lookup: 'unset', payRail: 'unset', blocker: 'socket.psp-partners' });
    expect(founder.counts.failed).toBe(0);
    expect(founder.volumes).toEqual([]);
  });

  it("does not pay from another person's space", async () => {
    const { ledger, bank } = mount();
    const theirs = await funded(bank, ledger, OTHER);
    await expect(
      caller(bank, USER, write).bills.pay({
        idempotencyKey: 'bill-key-03',
        billerId: 'power-de',
        reference: '100',
        amount: '10',
        fromSpaceId: theirs.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', cause: { code: 'bank.bills_space_not_found' } });
    expect(transfers(ledger)).toHaveLength(0);
  });

  it('requires step-up when the gate is on, and still posts nothing while the rail is blank', async () => {
    const { ledger, bank } = mount();
    const space = await funded(bank, ledger);
    const identity = approvingIdentity();
    const stepUp = createStepUpGate({ mode: 'required', approvals: identity });
    const me = caller(bank, USER, write, stepUp);
    const input = { idempotencyKey: 'bill-key-04', billerId: 'power-de', reference: '100', amount: '10.00', fromSpaceId: space.id };
    await expect(me.bills.pay(input)).rejects.toMatchObject({ cause: { code: 'bank.step_up_required' } });
    expect(await me.bills.list({ limit: 10 })).toMatchObject({ items: [] });
    const binding = billPayStepUp({ actor: USER, ...input, assetId: 'USDT' });
    const stepUpApprovalId = identity.approve(binding.actionType, binding.fields, USER);
    await expect(me.bills.pay({ ...input, stepUpApprovalId })).rejects.toMatchObject({ cause: { code: 'bank.bills_psp_unset' } });
    expect(transfers(ledger)).toHaveLength(0);
  });

  it('posts a live bill once through the ledger and returns the provider reference', async () => {
    let submits = 0;
    const { ledger, bank } = mount({
      bills: liveBills(async () => {
        submits += 1;
        return { ok: true, providerRef: 'bill-ref-1', status: 'accepted' };
      }),
    });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    const found = await me.bills.billers.search({ query: 'power', country: 'DE' });
    expect(found).toEqual([{ id: 'power-de', name: 'TEST POWER', country: 'DE', category: 'utility' }]);
    expect(await me.bills.lookup({ billerId: 'power-de', reference: '100' })).toEqual({
      amountDue: '25.00',
      dueDate: '2026-11-01',
      payeeName: 'TEST POWER',
      currency: 'EUR',
    });
    const input = { idempotencyKey: 'bill-key-05', billerId: 'power-de', reference: '100', amount: '10', fromSpaceId: space.id };
    const paid = await me.bills.pay(input);
    const again = await me.bills.pay(input);
    expect(again).toMatchObject({ id: paid.id, status: 'accepted', providerRef: 'bill-ref-1', ledgerTxId: paid.ledgerTxId, amount: '10' });
    expect(submits).toBe(1);
    expect(transfers(ledger)).toHaveLength(1);
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(parseAmount('90'));
    const got = await me.bills.get({ id: paid.id });
    expect(got.ledgerTxId).toBe(paid.ledgerTxId);
    await expect(caller(bank, OTHER, read).bills.get({ id: paid.id })).rejects.toMatchObject({ cause: { code: 'bank.bills_not_found' } });
    const founder = await caller(bank, USER, ['admin:read']).bills.ops.summary();
    expect(founder.counts.accepted).toBe(1);
    expect(founder.volumes).toEqual([{ status: 'accepted', assetId: 'USDT', count: 1, amount: '10' }]);
    expect(founder.rails.payRail).toBe('live');
  });

  it('reverses a refused live bill and does not reverse it again on retry', async () => {
    const { ledger, bank } = mount({ bills: liveBills(async () => ({ ok: false })) });
    const space = await funded(bank, ledger);
    const input = { idempotencyKey: 'bill-key-06', billerId: 'power-de', reference: '100', amount: '10', fromSpaceId: space.id };
    const me = caller(bank, USER, write);
    await expect(me.bills.pay(input)).rejects.toMatchObject({ cause: { code: 'bank.bills_rail_refused' } });
    await expect(me.bills.pay(input)).rejects.toMatchObject({ cause: { code: 'bank.bills_rail_refused' } });
    expect(transfers(ledger)).toHaveLength(2);
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(parseAmount('100'));
    const failed = await caller(bank, USER, ['admin:read']).bills.ops.failed({ limit: 10 });
    expect(failed.items[0]).toMatchObject({ userId: USER, failureCode: 'bank.bills_rail_refused', ledgerTxId: null });
    const drill = await caller(bank, USER, ['admin:read']).bills.ops.get({ id: failed.items[0]!.id });
    expect(drill.userId).toBe(USER);
  });

  it('refuses an unaffordable live bill before the rail is told, and runs a recurring bill once', async () => {
    let submits = 0;
    const { ledger, bank } = mount({
      bills: liveBills(async () => {
        submits += 1;
        return { ok: true, providerRef: 'bill-ref-2', status: 'paid' };
      }),
    });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    await expect(
      me.bills.pay({
        idempotencyKey: 'bill-key-07',
        billerId: 'power-de',
        reference: '100',
        amount: '1000',
        fromSpaceId: space.id,
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.bills_insufficient_funds' } });
    expect(submits).toBe(0);
    expect(transfers(ledger)).toHaveLength(0);
    const schedule = await me.bills.recurring.create({
      idempotencyKey: 'recur-key-2',
      billerId: 'power-de',
      reference: '100',
      amount: '10',
      fromSpaceId: space.id,
      cadence: 'weekly',
      startsAt: '2020-01-01T00:00:00.000Z',
    });
    await me.bills.recurring.pause({ id: schedule.id });
    expect((await me.bills.recurring.list({ limit: 5 }))[0]?.status).toBe('paused');
    await expect(caller(bank, OTHER, write).bills.recurring.cancel({ id: schedule.id })).rejects.toMatchObject({
      cause: { code: 'bank.bill_recurring_not_found' },
    });
    const runWhilePaused = await bank.bills.runDue(10, new Date('2026-10-17T00:00:00.000Z'));
    expect(runWhilePaused.considered).toBe(0);
    await me.bills.recurring.cancel({ id: schedule.id });
    const active = await me.bills.recurring.create({
      idempotencyKey: 'recur-key-3',
      billerId: 'power-de',
      reference: '100',
      amount: '10',
      fromSpaceId: space.id,
      cadence: 'weekly',
      startsAt: '2026-10-17T00:00:00.000Z',
    });
    const first = await bank.bills.runDue(10, new Date('2026-10-17T00:00:00.000Z'));
    const second = await bank.bills.runDue(10, new Date('2026-10-17T00:00:00.000Z'));
    expect(first.settled).toBe(1);
    expect(second.settled).toBe(0);
    expect(transfers(ledger)).toHaveLength(1);
    expect(active.id).toBeTruthy();
  });

  it('refuses corridors, quotes and sends while those ports are blank', async () => {
    const { ledger, bank } = mount();
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    await expect(me.global.corridors.list()).rejects.toMatchObject({
      message: expect.stringContaining('socket.psp-partners') as unknown as string,
      cause: { code: 'bank.global_corridors_unset', blocker: 'socket.psp-partners' },
    });
    await expect(me.global.quote({ asset: 'USDT', amount: '10', toCurrency: 'EUR' })).rejects.toMatchObject({
      message: expect.not.stringMatching(/\d+\.\d+/) as unknown as string,
      cause: { code: 'bank.global_fx_unset' },
    });
    const checked = await me.global.recipients.validate({ account: 'GB82WEST12345698765432', bic: 'DEUTDEFF' });
    expect(checked).toMatchObject({
      format: 'valid',
      formatKind: 'iban',
      bicLookup: { status: 'refused', code: 'bank.global_bic_directory_unset', blocker: 'socket.psp-partners' },
    });
    expect(JSON.stringify(checked)).not.toContain('TEST BANK');
    const saved = await me.global.recipients.add({
      idempotencyKey: 'recip-key-1',
      name: 'Ada',
      account: 'GB82 WEST 1234 5698 7654 32',
      country: 'GB',
      bic: 'DEUTDEFF',
    });
    expect(saved.accountKind).toBe('iban');
    expect(await me.global.recipients.list({ limit: 10 })).toHaveLength(1);
    await expect(
      me.global.recipients.add({
        idempotencyKey: 'recip-key-2',
        name: 'No',
        account: 'not-an-account',
        country: 'GB',
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.global_account_format_invalid' } });
    await expect(
      me.global.send({
        idempotencyKey: 'send-key-01',
        fromSpaceId: space.id,
        amount: '10',
        toCurrency: 'EUR',
        recipientId: saved.id,
        country: 'DE',
        deliveryMethod: 'bank',
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.global_corridors_unset' } });
    expect(transfers(ledger)).toHaveLength(0);
    await expect(
      caller(bank, OTHER, write).global.recipients.remove({ recipientId: saved.id, idempotencyKey: 'recip-rm-01' }),
    ).rejects.toMatchObject({
      cause: { code: 'bank.global_recipient_not_found' },
    });
    expect(await me.global.recipients.remove({ recipientId: saved.id, idempotencyKey: 'recip-rm-02' })).toEqual({ removed: true });
  });

  it('names the next blank port, then posts one send with the provider quote unchanged', async () => {
    const fxOnly = liveGlobal();
    const { ledger, bank } = mount({
      global: {
        ...fxOnly,
        fx: { status: () => 'unset', quote: async () => QUOTE },
        payout: { status: () => 'unset', railId: () => '', submit: async () => ({ ok: false }) },
        travelRule: { decision: () => null },
      },
    });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    const saved = await me.global.recipients.add({
      idempotencyKey: 'recip-key-3',
      name: 'Ada',
      account: '123456789',
      country: 'DE',
    });
    const send = {
      fromSpaceId: space.id,
      amount: '10',
      toCurrency: 'EUR',
      recipientId: saved.id,
      country: 'DE',
      deliveryMethod: 'bank',
      compliance: { originatorName: 'Ada' },
    };
    await expect(me.global.send({ ...send, idempotencyKey: 'send-key-02' })).rejects.toMatchObject({
      cause: { code: 'bank.global_fx_unset' },
    });
    expect(transfers(ledger)).toHaveLength(0);

    const { ledger: ledger2, bank: bank2 } = mount({
      global: liveGlobal({ payout: { status: () => 'unset', railId: () => '', submit: async () => ({ ok: false }) } }),
    });
    const space2 = await funded(bank2, ledger2);
    const me2 = caller(bank2, USER, write);
    const saved2 = await me2.global.recipients.add({ idempotencyKey: 'recip-key-4', name: 'Ada', account: '123456789', country: 'DE' });
    const quote = await me2.global.quote({ asset: 'USDT', amount: '10', toCurrency: 'EUR' });
    expect(quote).toEqual(QUOTE);
    expect(quote.receiveAmount).toBe('71.41');
    await expect(
      me2.global.send({
        ...send,
        fromSpaceId: space2.id,
        recipientId: saved2.id,
        idempotencyKey: 'send-key-03',
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.global_payout_unset' } });

    const { ledger: ledger3, bank: bank3 } = mount({
      global: liveGlobal({ travelRule: { decision: () => null } }),
    });
    const space3 = await funded(bank3, ledger3);
    const me3 = caller(bank3, USER, write);
    const saved3 = await me3.global.recipients.add({ idempotencyKey: 'recip-key-5', name: 'Ada', account: '123456789', country: 'DE' });
    await expect(
      me3.global.send({
        ...send,
        fromSpaceId: space3.id,
        recipientId: saved3.id,
        idempotencyKey: 'send-key-04',
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.global_travel_rule_undecided' } });
    expect(transfers(ledger3)).toHaveLength(0);

    let submits = 0;
    const { ledger: ledger4, bank: bank4 } = mount({
      sendFieldRules: RULES,
      global: liveGlobal({
        payout: {
          status: () => 'live',
          railId: () => 'test-payout-rail',
          async submit() {
            submits += 1;
            return { ok: true, providerRef: 'payout-1', status: 'sent' };
          },
        },
      }),
    });
    const space4 = await funded(bank4, ledger4);
    const me4 = caller(bank4, USER, write);
    const saved4 = await me4.global.recipients.add({ idempotencyKey: 'recip-key-6', name: 'Ada', account: '123456789', country: 'DE' });
    const body = { ...send, fromSpaceId: space4.id, recipientId: saved4.id, idempotencyKey: 'send-key-05' };
    const sent = await me4.global.send(body);
    const again = await me4.global.send(body);
    expect(again).toMatchObject({
      id: sent.id,
      status: 'sent',
      providerRef: 'payout-1',
      quoteRate: '7.25',
      quoteFee: '1.10',
      quoteReceive: '71.41',
      ledgerTxId: sent.ledgerTxId,
    });
    expect(submits).toBe(1);
    expect(transfers(ledger4)).toHaveLength(1);
    expect((await ledger4.balance(userAvailable(USER, 'USDT'))).amount).toBe(parseAmount('90'));
    const listed = await me4.global.list({ limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toEqual(expect.any(String));
    const rest = await me4.global.list({ limit: 10, cursor: listed.nextCursor! });
    expect(rest.items.length).toBeGreaterThan(0);
    expect([...listed.items, ...rest.items].some((item) => item.id === sent.id && item.status === 'sent')).toBe(true);
    const founder = await caller(bank4, USER, ['admin:read']).global.ops.summary();
    expect(founder.counts.sent).toBe(1);
    expect(founder.rails.travelRule).toBe('recorded');
    expect(founder.rails.blocker).toBe('socket.psp-partners');
    const named = await me4.global.recipients.validate({ account: '123456789', bic: 'DEUTDEFF' });
    expect(named.bicLookup).toEqual({ status: 'matched', bic: 'DEUTDEFF', bankName: 'TEST BANK' });
  });

  it('holds a send to the owner table for reference, purpose and source of funds, and posts nothing when it refuses', async () => {
    const attempt = async (
      rules: string | undefined,
      over: { amount?: string; toCurrency?: string; compliance?: Record<string, string> },
      key: string,
    ) => {
      const { ledger, bank } = mount({ sendFieldRules: rules, global: liveGlobal() });
      const space = await funded(bank, ledger);
      const me = caller(bank, USER, write);
      const saved = await me.global.recipients.add({ idempotencyKey: `recip-${key}`, name: 'Ada', account: '123456789', country: 'DE' });
      const result = await me.global
        .send({
          idempotencyKey: key,
          fromSpaceId: space.id,
          amount: over.amount ?? '10',
          toCurrency: over.toCurrency ?? 'EUR',
          recipientId: saved.id,
          country: 'DE',
          deliveryMethod: 'bank',
          compliance: { originatorName: 'Ada', ...over.compliance },
        })
        .then(
          () => 'sent',
          (err: { cause?: { code?: string; message?: string } }) => err.cause,
        );
      return { result, posted: transfers(ledger).length };
    };

    // The table was never published: refused, nothing posted.
    expect(await attempt(undefined, {}, 'fields-01')).toMatchObject({ result: { code: 'bank.send_field_rules_unset' }, posted: 0 });
    expect(await attempt('{"reference": "x"}', {}, 'fields-02')).toMatchObject({
      result: { code: 'bank.send_field_rules_unset' },
      posted: 0,
    });
    // A reference on a rail the table has no rule for.
    expect(
      await attempt(
        JSON.stringify({ reference: [{ deliveryMethod: 'wire', maxLength: 10 }], purposeRequired: [], sourceOfFunds: [] }),
        { compliance: { reference: 'INV1' } },
        'fields-03',
      ),
    ).toMatchObject({
      result: { code: 'bank.reference_rules_unset' },
      posted: 0,
    });
    // The country rule wins over the rail rule, and the limit is named.
    expect(await attempt(RULES, { compliance: { reference: 'x'.repeat(13) } }, 'fields-04')).toMatchObject({
      result: { code: 'bank.reference_too_long', message: expect.stringContaining('12') },
      posted: 0,
    });
    // Purpose is needed for the owner's currencies, not for others.
    expect(await attempt(RULES, { toCurrency: 'INR' }, 'fields-05')).toMatchObject({
      result: { code: 'bank.send_purpose_required' },
      posted: 0,
    });
    // Source of funds is needed above the threshold, not at it.
    expect(await attempt(RULES, { amount: '50.000000000000000001' }, 'fields-06')).toMatchObject({
      result: { code: 'bank.source_of_funds_required' },
      posted: 0,
    });
    expect(await attempt(RULES, { amount: '50', compliance: { reference: 'x'.repeat(12) } }, 'fields-07')).toEqual({
      result: 'sent',
      posted: 1,
    });
    expect(
      await attempt(RULES, { amount: '60', toCurrency: 'INR', compliance: { purpose: 'family', sourceOfFunds: 'salary' } }, 'fields-08'),
    ).toEqual({
      result: 'sent',
      posted: 1,
    });
  });

  const sendBody = { toCurrency: 'EUR', country: 'DE', deliveryMethod: 'bank', compliance: { originatorName: 'Ada' } };

  it('refuses every send while the payee controls are unset, and a blocked payee without naming the list', async () => {
    const unset = mount({ sendFieldRules: RULES, global: liveGlobal(), payeeControls: null });
    const space = await funded(unset.bank, unset.ledger);
    const me = caller(unset.bank, USER, write);
    const saved = await me.global.recipients.add({ idempotencyKey: 'recip-pc-01', name: 'Ada', account: '123456789', country: 'DE' });
    await expect(
      me.global.send({ ...sendBody, idempotencyKey: 'send-pc-01', amount: '10', fromSpaceId: space.id, recipientId: saved.id }),
    ).rejects.toMatchObject({ cause: { code: 'bank.payee_controls_unset' } });
    expect(transfers(unset.ledger)).toHaveLength(0);
    const desk = await caller(unset.bank, OP_A, compliance).global.ops.controls();
    expect(desk.payeeControls).toEqual({ state: 'unset', blockedCount: 0 });

    const blocked = mount({
      sendFieldRules: RULES,
      global: liveGlobal(),
      payeeControls: JSON.stringify({ blockedAccounts: ['1234 56789'] }),
    });
    const space2 = await funded(blocked.bank, blocked.ledger);
    const me2 = caller(blocked.bank, USER, write);
    const saved2 = await me2.global.recipients.add({ idempotencyKey: 'recip-pc-02', name: 'Ada', account: '123456789', country: 'DE' });
    const refused: { message: string; cause: { code: string } } = await me2.global
      .send({ ...sendBody, idempotencyKey: 'send-pc-02', amount: '10', fromSpaceId: space2.id, recipientId: saved2.id })
      .then(
        () => {
          throw new Error('the send should have been refused');
        },
        (err: { message: string; cause: { code: string } }) => err,
      );
    expect(refused).toMatchObject({ cause: { code: 'bank.payee_blocked' } });
    expect(refused.message).not.toMatch(/123456789|1234 56789|blockedAccounts/);
    expect(transfers(blocked.ledger)).toHaveLength(0);
    const desk2 = await caller(blocked.bank, OP_A, compliance).global.ops.controls();
    expect(desk2.payeeControls).toEqual({ state: 'published', blockedCount: 1 });

    // A published empty list blocks nothing.
    const open = mount({ sendFieldRules: RULES, global: liveGlobal(), payeeControls: JSON.stringify({ blockedAccounts: [] }) });
    const space3 = await funded(open.bank, open.ledger);
    const me3 = caller(open.bank, USER, write);
    const saved3 = await me3.global.recipients.add({ idempotencyKey: 'recip-pc-03', name: 'Ada', account: '123456789', country: 'DE' });
    await expect(
      me3.global.send({ ...sendBody, idempotencyKey: 'send-pc-03', amount: '10', fromSpaceId: space3.id, recipientId: saved3.id }),
    ).resolves.toMatchObject({ status: 'sent' });
  });

  async function seeded(options: Parameters<typeof mount>[0] = {}) {
    const { ledger, bank } = mount({ sendFieldRules: RULES, global: liveGlobal(), ...options });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    const saved = await me.global.recipients.add({
      idempotencyKey: `recip-${randomUUID()}`,
      name: 'Ada',
      account: '123456789',
      country: 'DE',
    });
    const id = randomUUID();
    // A send that has been taken in but has not left: the only kind a hold can catch.
    await sql`
      INSERT INTO bank.global_sends (id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
                                     country, delivery_method, compliance, status)
      VALUES (${id}, ${USER}, ${`seed-${id}`}, ${space.id}, 'USDT', '10', 'EUR', ${saved.id}, 'DE', 'bank',
              '{"originatorName":"Ada"}', 'submitted')
    `;
    return { ledger, bank, me, id, ops: caller(bank, OP_A, compliance), other: caller(bank, OP_B, compliance) };
  }

  it('holds a send that has not left, shows the customer only the request, and moves it to review once on upload', async () => {
    const { ledger, me, id, ops } = await seeded({ proofLimits: PROOF_LIMITS });
    const held = await ops.global.ops.hold({
      sendId: id,
      holdKey: 'hold-key-01',
      reason: 'screening hit 7',
      infoRequest: 'Please send your payslip.',
    });
    expect(held).toMatchObject({ state: 'requested', heldBy: OP_A, reason: 'screening hit 7' });
    expect(
      await ops.global.ops.hold({
        sendId: id,
        holdKey: 'hold-key-01',
        reason: 'screening hit 7',
        infoRequest: 'Please send your payslip.',
      }),
    ).toMatchObject({
      id: held.id,
    });
    await expect(ops.global.ops.hold({ sendId: id, holdKey: 'hold-key-01', reason: 'another' })).rejects.toMatchObject({
      cause: { code: 'bank.hold_conflict' },
    });
    expect((await me.global.get({ id })).status).toBe('held');
    expect((await ops.global.ops.holds({ limit: 10 })).map((row) => row.sendId)).toEqual([id]);

    const mine = await me.global.hold.get({ id });
    expect(mine).toEqual({
      state: 'requested',
      infoRequest: 'Please send your payslip.',
      proofUploaded: false,
      proofLimits: { allowedTypes: ['application/pdf'], maxBytes: 64 },
    });
    expect(JSON.stringify(mine)).not.toMatch(/screening|heldBy|reason/);
    await expect(caller(await seededOther(), OTHER, write).global.hold.get({ id })).rejects.toBeTruthy();

    const file = Buffer.from('%PDF-1.4 payslip').toString('base64');
    await expect(me.global.hold.uploadProof({ id, name: 'p.png', type: 'image/png', contentBase64: file })).rejects.toMatchObject({
      cause: { code: 'bank.proof_type_not_allowed' },
    });
    await expect(
      me.global.hold.uploadProof({ id, name: 'p.pdf', type: 'application/pdf', contentBase64: Buffer.alloc(65, 1).toString('base64') }),
    ).rejects.toMatchObject({ cause: { code: 'bank.proof_too_large' } });
    const up = await me.global.hold.uploadProof({ id, name: 'p.pdf', type: 'application/pdf', contentBase64: file });
    expect(up).toMatchObject({ state: 'under_review', proofUploaded: true });
    // The same file again is the same answer; a different one is refused.
    expect(await me.global.hold.uploadProof({ id, name: 'p.pdf', type: 'application/pdf', contentBase64: file })).toMatchObject({
      state: 'under_review',
    });
    await expect(
      me.global.hold.uploadProof({
        id,
        name: 'q.pdf',
        type: 'application/pdf',
        contentBase64: Buffer.from('%PDF other').toString('base64'),
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.proof_already_uploaded' } });
    const stored = await ops.global.ops.proof({ sendId: id });
    expect(Buffer.from(stored.contentBase64, 'base64').toString()).toBe('%PDF-1.4 payslip');
    expect(transfers(ledger)).toHaveLength(0);
  });

  async function seededOther() {
    return mount({ sendFieldRules: RULES, global: liveGlobal() }).bank;
  }

  it('refuses an upload while no limits are published, and while nothing was asked for', async () => {
    const { me, id, ops } = await seeded();
    await ops.global.ops.hold({ sendId: id, holdKey: 'hold-key-02', reason: 'review' });
    await expect(me.global.hold.uploadProof({ id, name: 'p.pdf', type: 'application/pdf', contentBase64: 'AAAA' })).rejects.toMatchObject({
      cause: { code: 'bank.proof_limits_unset' },
    });
    const withLimits = await seeded({ proofLimits: PROOF_LIMITS });
    await withLimits.ops.global.ops.hold({ sendId: withLimits.id, holdKey: 'hold-key-03', reason: 'review' });
    await expect(
      withLimits.me.global.hold.uploadProof({ id: withLimits.id, name: 'p.pdf', type: 'application/pdf', contentBase64: 'AAAA' }),
    ).rejects.toMatchObject({ cause: { code: 'bank.proof_not_requested' } });
    await withLimits.ops.global.ops.requestInfo({ sendId: withLimits.id, infoRequest: 'Source of funds, please.' });
    await expect(
      withLimits.me.global.hold.uploadProof({ id: withLimits.id, name: 'p.pdf', type: 'application/pdf', contentBase64: 'AAAA' }),
    ).resolves.toMatchObject({ state: 'under_review' });
  });

  it('releases only by a different person, then sends once; a settled send cannot be held', async () => {
    const { ledger, me, id, ops, other } = await seeded();
    await ops.global.ops.hold({ sendId: id, holdKey: 'hold-key-04', reason: 'review' });
    await expect(ops.global.ops.release({ sendId: id })).rejects.toMatchObject({ cause: { code: 'bank.release_same_operator' } });
    expect((await me.global.get({ id })).status).toBe('held');
    expect(transfers(ledger)).toHaveLength(0);
    const released = await other.global.ops.release({ sendId: id });
    expect(released).toMatchObject({ id, status: 'sent', providerRef: 'payout-1' });
    expect(transfers(ledger)).toHaveLength(1);
    await expect(other.global.ops.release({ sendId: id })).rejects.toMatchObject({ cause: { code: 'bank.hold_not_found' } });
    expect(transfers(ledger)).toHaveLength(1);
    await expect(ops.global.ops.hold({ sendId: id, holdKey: 'hold-key-05', reason: 'late' })).rejects.toMatchObject({
      cause: { code: 'bank.transfer_settled' },
    });
    expect((await me.global.hold.get({ id })).state).toBe('released');
  });

  it('links an incoming reference to a held send, resumes it, and logs the link once', async () => {
    const { ledger, id, ops, other } = await seeded();
    await ops.global.ops.hold({ sendId: id, holdKey: 'hold-key-06', reason: 'unreferenced credit' });
    await expect(ops.global.ops.linkReference({ sendId: id, reference: 'PAY-12345' })).rejects.toMatchObject({
      cause: { code: 'bank.release_same_operator' },
    });
    const linked = await other.global.ops.linkReference({ sendId: id, reference: 'pay-12345' });
    expect(linked).toMatchObject({ linked: true, send: { id, status: 'sent' } });
    expect(transfers(ledger)).toHaveLength(1);
    const rows = await sql<{ reference: string; linked_by: string }[]>`SELECT reference, linked_by FROM bank.global_incoming_links`;
    expect(rows).toEqual([{ reference: 'PAY-12345', linked_by: OP_B }]);
    expect(await other.global.ops.linkReference({ sendId: id, reference: 'PAY-12345' })).toMatchObject({ linked: true });
    expect(transfers(ledger)).toHaveLength(1);
    // The same reference cannot be tied to a second send, and that send stays held.
    const second = await seeded();
    await second.ops.global.ops.hold({ sendId: second.id, holdKey: 'hold-key-08', reason: 'unreferenced credit' });
    await expect(second.other.global.ops.linkReference({ sendId: second.id, reference: 'PAY-12345' })).rejects.toMatchObject({
      cause: { code: 'bank.link_reference_conflict' },
    });
    expect((await second.me.global.get({ id: second.id })).status).toBe('held');
    expect(transfers(second.ledger)).toHaveLength(0);
  });

  it('keeps hold and release to the compliance scope', async () => {
    const { me, id } = await seeded();
    await expect(me.global.ops.hold({ sendId: id, holdKey: 'hold-key-07', reason: 'x' })).rejects.toBeTruthy();
    await expect(me.global.ops.holds({ limit: 5 })).rejects.toBeTruthy();
  });

  it('a hold that lands while the forward entry is posted stops the payout, and release pays out once without posting again', async () => {
    let submits = 0;
    const { ledger, bank } = mount({
      sendFieldRules: RULES,
      global: liveGlobal({
        payout: {
          status: () => 'live',
          railId: () => 'test-payout-rail',
          async submit() {
            submits += 1;
            return { ok: true, providerRef: 'payout-9', status: 'sent' };
          },
        },
      }),
    });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    const ops = caller(bank, OP_A, compliance);
    const saved = await me.global.recipients.add({ idempotencyKey: 'recip-race-01', name: 'Ada', account: '123456789', country: 'DE' });
    const post = ledger.post.bind(ledger);
    let placed = false;
    ledger.post = (async (...args: Parameters<typeof post>) => {
      const result = await post(...args);
      if (!placed) {
        placed = true;
        const rows = await sql<{ id: string }[]>`SELECT id FROM bank.global_sends`;
        await ops.global.ops.hold({ sendId: rows[0]!.id, holdKey: 'hold-race-01', reason: 'late screening' });
      }
      return result;
    }) as typeof ledger.post;
    const view = await me.global.send({
      ...sendBody,
      idempotencyKey: 'send-race-01',
      amount: '10',
      fromSpaceId: space.id,
      recipientId: saved.id,
    });
    expect(view.status).toBe('held');
    expect(submits).toBe(0);
    expect(transfers(ledger)).toHaveLength(1);
    const released = await caller(bank, OP_B, compliance).global.ops.release({ sendId: view.id });
    expect(released).toMatchObject({ status: 'sent', providerRef: 'payout-9' });
    expect(submits).toBe(1);
    expect(transfers(ledger)).toHaveLength(1);
  });

  it('holds sends to an exchange to the owner allowance in a rolling window, and refuses while it is unset', async () => {
    const unset = mount({ sendFieldRules: RULES, global: liveGlobal(), exchangeAllowance: null });
    const space0 = await funded(unset.bank, unset.ledger);
    const me0 = caller(unset.bank, USER, write);
    const saved0 = await me0.global.recipients.add({ idempotencyKey: 'recip-ex-00', name: 'Ada', account: '123456789', country: 'DE' });
    await expect(
      me0.global.send({ ...sendBody, idempotencyKey: 'send-ex-00', amount: '10', fromSpaceId: space0.id, recipientId: saved0.id }),
    ).rejects.toMatchObject({ cause: { code: 'bank.exchange_allowance_unset' } });
    expect(transfers(unset.ledger)).toHaveLength(0);
    expect((await caller(unset.bank, OP_A, compliance).global.ops.controls()).exchangeAllowance).toEqual({
      state: 'unset',
      windowDays: null,
      exchangeCount: 0,
    });

    const allowance = JSON.stringify({ exchangeAccounts: ['9999 99999'], windowDays: 30, limits: [{ asset: 'USDT', maxAmount: '30' }] });
    const { ledger, bank } = mount({ sendFieldRules: RULES, global: liveGlobal(), exchangeAllowance: allowance });
    const space = await funded(bank, ledger);
    const me = caller(bank, USER, write);
    const exchange = await me.global.recipients.add({
      idempotencyKey: 'recip-ex-01',
      name: 'Exchange',
      account: '999999999',
      country: 'DE',
    });
    const friend = await me.global.recipients.add({ idempotencyKey: 'recip-ex-02', name: 'Ada', account: '123456789', country: 'DE' });
    const to = (recipientId: string, key: string, amount: string) =>
      me.global.send({ ...sendBody, idempotencyKey: key, amount, fromSpaceId: space.id, recipientId });
    await expect(to(exchange.id, 'send-ex-01', '20')).resolves.toMatchObject({ status: 'sent' });
    // 20 already sent in the window: 11 more is over 30; nothing is posted for it.
    await expect(to(exchange.id, 'send-ex-02', '11')).rejects.toMatchObject({ cause: { code: 'bank.exchange_allowance_exceeded' } });
    expect(transfers(ledger)).toHaveLength(1);
    // A refused send does not use up the room; exactly the rest fits.
    await expect(to(exchange.id, 'send-ex-03', '10')).resolves.toMatchObject({ status: 'sent' });
    // A recipient that is not an exchange is not counted.
    await expect(to(friend.id, 'send-ex-04', '40')).resolves.toMatchObject({ status: 'sent' });
    // The replay of a refused send is the same refusal.
    await expect(to(exchange.id, 'send-ex-02', '11')).rejects.toMatchObject({ cause: { code: 'bank.exchange_allowance_exceeded' } });
    expect(transfers(ledger)).toHaveLength(3);
    expect((await caller(bank, OP_A, compliance).global.ops.controls()).exchangeAllowance).toEqual({
      state: 'published',
      windowDays: 30,
      exchangeCount: 1,
    });

    // A limit too large for the ledger to read makes the setting unreadable: refused as unset, nothing thrown.
    const huge = mount({
      sendFieldRules: RULES,
      global: liveGlobal(),
      exchangeAllowance: JSON.stringify({ exchangeAccounts: [], windowDays: 30, limits: [{ asset: 'USDT', maxAmount: '9'.repeat(40) }] }),
    });
    const spaceH = await funded(huge.bank, huge.ledger);
    const meH = caller(huge.bank, USER, write);
    const exH = await meH.global.recipients.add({ idempotencyKey: 'recip-ex-04', name: 'Ada', account: '123456789', country: 'DE' });
    await expect(
      meH.global.send({ ...sendBody, idempotencyKey: 'send-ex-06', amount: '1', fromSpaceId: spaceH.id, recipientId: exH.id }),
    ).rejects.toMatchObject({ cause: { code: 'bank.exchange_allowance_unset' } });

    // An exchange with no limit for the asset is refused as unset, never allowed.
    const bare = mount({
      sendFieldRules: RULES,
      global: liveGlobal(),
      exchangeAllowance: JSON.stringify({ exchangeAccounts: ['999999999'], windowDays: 30, limits: [] }),
    });
    const spaceB = await funded(bare.bank, bare.ledger);
    const meB = caller(bare.bank, USER, write);
    const exB = await meB.global.recipients.add({ idempotencyKey: 'recip-ex-03', name: 'Exchange', account: '999999999', country: 'DE' });
    await expect(
      meB.global.send({ ...sendBody, idempotencyKey: 'send-ex-05', amount: '1', fromSpaceId: spaceB.id, recipientId: exB.id }),
    ).rejects.toMatchObject({ cause: { code: 'bank.exchange_allowance_unset' } });
  });

  describe('when the payout rail refuses or its answer is lost (global.ts payout step)', () => {
    type Answer = Awaited<ReturnType<GlobalPorts['payout']['submit']>>;
    /** A payout port whose next answers the test sets; each call takes the next one. `throw` stands for a lost reply. */
    function scriptedPayout(answers: Array<Answer | 'throw'>) {
      const calls: string[] = [];
      const port: GlobalPorts['payout'] = {
        status: () => 'live',
        railId: () => 'test-payout-rail',
        async submit(input) {
          calls.push(input.sendId);
          const next = answers.shift();
          if (next === undefined || next === 'throw') throw new Error('payout reply lost');
          return next;
        },
      };
      return { port, calls };
    }

    async function ready(payout: GlobalPorts['payout']) {
      const { ledger, bank } = mount({ sendFieldRules: RULES, global: liveGlobal({ payout }) });
      const space = await funded(bank, ledger);
      const me = caller(bank, USER, write);
      const saved = await me.global.recipients.add({
        idempotencyKey: `recip-${randomUUID()}`,
        name: 'Ada',
        account: '123456789',
        country: 'DE',
      });
      const body = {
        fromSpaceId: space.id,
        amount: '10',
        toCurrency: 'EUR',
        recipientId: saved.id,
        country: 'DE',
        deliveryMethod: 'bank',
        compliance: { originatorName: 'Ada' },
        idempotencyKey: `send-${randomUUID()}`,
      };
      const balance = async () => (await ledger.balance(userAvailable(USER, 'USDT'))).amount;
      const row = async () =>
        (
          await sql<Array<{ status: string; failure_code: string | null; ledger_tx_id: string | null; provider_ref: string | null }>>`
            SELECT status, failure_code, ledger_tx_id, provider_ref FROM bank.global_sends WHERE idempotency_key = ${body.idempotencyKey}
          `
        )[0];
      return { ledger, me, body, balance, row };
    }

    it('a refused payout returns the money in the same step, once, and the send is failed with the reason', async () => {
      const rail = scriptedPayout([{ ok: false }]);
      const { ledger, me, body, balance, row } = await ready(rail.port);
      await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_payout_refused' } });
      expect(transfers(ledger)).toHaveLength(2); // out to the rail, and back
      expect(await balance()).toBe(parseAmount('100'));
      expect(await row()).toMatchObject({ status: 'failed', failure_code: 'bank.global_payout_refused', ledger_tx_id: null });

      // The same request again: the rail is not asked again and nothing more is posted.
      await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_payout_refused' } });
      expect(rail.calls).toHaveLength(1);
      expect(transfers(ledger)).toHaveLength(2);
      expect(await balance()).toBe(parseAmount('100'));
    });

    it('a lost payout reply keeps the debit and says the outcome is unknown; the retry asks the rail again and never posts twice', async () => {
      const rail = scriptedPayout(['throw', { ok: true, providerRef: 'payout-7', status: 'sent' }]);
      const { ledger, me, body, balance, row } = await ready(rail.port);
      await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_outcome_unknown' } });
      // The rail may have paid: the money stays out, the send stays open with its ledger entry, nothing is refunded.
      expect(transfers(ledger)).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('90'));
      const open = await row();
      expect(open).toMatchObject({ status: 'submitted', failure_code: null, provider_ref: null });
      expect(open?.ledger_tx_id).toEqual(expect.any(String));

      const settled = await me.global.send(body);
      expect(settled).toMatchObject({ status: 'sent', providerRef: 'payout-7', ledgerTxId: open?.ledger_tx_id });
      expect(rail.calls).toHaveLength(2);
      expect(transfers(ledger)).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('90'));
    });

    it('a refused payout whose return cannot be posted stays open as unknown, and the retry returns the money once', async () => {
      const rail = scriptedPayout([{ ok: false }, { ok: false }]);
      const { ledger, me, body, balance, row } = await ready(rail.port);
      const post = ledger.post.bind(ledger);
      let failReturn = true;
      ledger.post = async (tx) => {
        // The forward entry is the first rail posting; the return is any rail posting after it.
        if (failReturn && tx.reason === 'bank.transfer.manual' && transfers(ledger).length === 1) throw new Error('ledger down');
        return post(tx);
      };
      await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_outcome_unknown' } });
      expect(transfers(ledger)).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('90'));
      expect(await row()).toMatchObject({ status: 'submitted', failure_code: null });

      failReturn = false;
      await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_payout_refused' } });
      expect(transfers(ledger)).toHaveLength(2);
      expect(await balance()).toBe(parseAmount('100'));
      expect(await row()).toMatchObject({ status: 'failed', failure_code: 'bank.global_payout_refused', ledger_tx_id: null });
    });

    it('an accepted payout with no usable reference or status is unknown, not sent: the debit stays and nothing is marked paid', async () => {
      for (const answer of [
        { ok: true, providerRef: '   ', status: 'sent' },
        { ok: true, providerRef: 'x'.repeat(129), status: 'sent' },
        { ok: true, providerRef: 'payout-8', status: 'delivered-maybe' },
      ] as Answer[]) {
        const rail = scriptedPayout([answer]);
        const { ledger, me, body, balance, row } = await ready(rail.port);
        await expect(me.global.send(body)).rejects.toMatchObject({ cause: { code: 'bank.global_outcome_unknown' } });
        expect(transfers(ledger)).toHaveLength(1);
        expect(await balance()).toBe(parseAmount('90'));
        expect(await row()).toMatchObject({ status: 'submitted', provider_ref: null });
      }
    });
  });

  describe('with the TEST global-send stand-in the local stack runs (global-sim.ts, the bank profile catalogue)', () => {
    const profile = JSON.parse(readFileSync(join(here, '../../../../tooling/profiles/test-owner-values/bank.json'), 'utf8')) as {
      values: Record<string, { value: string }>;
    };
    const stackValue = (name: string) => profile.values[name]!.value;

    async function ready() {
      const catalogue = parseGlobalSim(stackValue('BANK_GLOBAL_SIM_JSON'));
      if (!catalogue) throw new Error('the bank profile catalogue does not parse');
      const { ledger, bank } = mount({ sendFieldRules: stackValue('BANK_SEND_FIELD_RULES_JSON'), global: globalSimPorts(catalogue) });
      const space = await funded(bank, ledger);
      const me = caller(bank, USER, write);
      const saved = await me.global.recipients.add({
        idempotencyKey: `recip-${randomUUID()}`,
        name: 'Ada',
        account: 'DE89370400440532013000',
        country: 'DE',
      });
      const body = {
        fromSpaceId: space.id,
        amount: '40',
        toCurrency: 'EUR',
        recipientId: saved.id,
        country: 'DE',
        deliveryMethod: 'sepa',
        idempotencyKey: `send-${randomUUID()}`,
      };
      const balance = async () => (await ledger.balance(userAvailable(USER, 'USDT'))).amount;
      const rail = async () => (await ledger.balance(railBoundary(GLOBAL_SIM_RAIL, 'USDT'))).amount;
      return { ledger, me, body, balance, rail };
    }

    it('posts the send once to the stand-in rail boundary, keeps its TEST quote, and a retry posts nothing', async () => {
      const { ledger, me, body, balance, rail } = await ready();
      const sent = await me.global.send(body);
      expect(sent).toMatchObject({ status: 'sent', quoteRate: '2', quoteFee: '0', quoteReceive: '80', ledgerTxId: expect.any(String) });
      expect(sent.providerRef).toBe(`TEST-${sent.id}`);
      expect(transfers(ledger)).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('60'));
      // Exactly the amount reached the stand-in's rail boundary: one leg in, nothing else.
      expect(await rail()).toBe(parseAmount('40'));
      // The same request again is the same send: nothing more leaves the account.
      expect(await me.global.send(body)).toMatchObject({ id: sent.id, status: 'sent' });
      expect(transfers(ledger)).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('60'));
    });

    it('refuses a delivery method or corridor the catalogue does not hold, and an amount outside its TEST bounds, posting nothing', async () => {
      const { ledger, me, body, balance } = await ready();
      await expect(me.global.send({ ...body, deliveryMethod: 'bank_account' })).rejects.toMatchObject({
        cause: { code: 'bank.global_corridor_unknown', blocker: 'socket.psp-partners' },
      });
      await expect(me.global.send({ ...body, idempotencyKey: `send-${randomUUID()}`, toCurrency: 'GBP' })).rejects.toMatchObject({
        cause: { code: 'bank.global_corridor_unknown' },
      });
      // The catalogue's TEST bounds are the corridor's bounds: 1 to 1000.
      await expect(
        me.global.send({ ...body, idempotencyKey: `send-${randomUUID()}`, amount: '1000.000000000000000001' }),
      ).rejects.toMatchObject({
        cause: { code: 'bank.global_amount_outside_corridor' },
        message: expect.stringContaining('1000') as unknown as string,
      });
      await expect(me.global.send({ ...body, idempotencyKey: `send-${randomUUID()}`, amount: '0.5' })).rejects.toMatchObject({
        cause: { code: 'bank.global_amount_outside_corridor' },
      });
      expect(transfers(ledger)).toHaveLength(0);
      expect(await balance()).toBe(parseAmount('100'));
    });

    it('names itself: the customer read and the ops summary carry its TEST label, and no other ports do', async () => {
      const { me } = await ready();
      expect(await me.global.partner()).toEqual({ standIn: expect.stringMatching(/^TEST\b/) });
      const ops = caller(mount({ global: globalSimPorts(parseGlobalSim(stackValue('BANK_GLOBAL_SIM_JSON'))!) }).bank, OP_A, compliance);
      expect((await ops.global.ops.summary()).rails).toMatchObject({ corridors: 'live', standIn: expect.stringMatching(/^TEST\b/) });
      expect(await caller(mount().bank, USER, read).global.partner()).toEqual({ standIn: null });
    });
  });
});
