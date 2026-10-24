/**
 * Unit card — money out needs a same-person step-up approval bound to the exact payload
 * (ADR 2026-10-14-money-out-step-up, phase 1; BANK_STEP_UP_MONEY_OUT)
 *
 * 1. Promise: with the flag `required`, a send to another person, a standing order to one, business
 *    payments and membership, and card unfreeze/issue are refused unless `stepUpApprovalId` names a
 *    fresh identity approval for that user, session and EXACT payload; it spends once, and a retry of
 *    the same operation replays. Own-space moves and protective actions never prompt.
 * 2. Break: a session or a `trade:withdraw` bearer could spend any amount to any payee for five minutes.
 * 3. Done bar: per door a missing approval is `bank.step_up_required` and the service is never reached;
 *    amount / payee / asset / transferId changes mismatch; reuse, expiry, wrong user and wrong session
 *    refuse; identity down refuses closed; same transferId replays; flag off changes nothing; the two
 *    existing `trade:withdraw` doors ignore approvals and a withdraw token is no substitute on the new doors.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/router.ts, step-up/step-up-gate.ts, step-up/money-out-fields.ts
 * 6. RED before: every one of these doors ran on plain `bank:write`
 */
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { ActionApprovalConsumeError, bankActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { createStepUpGate, parseStepUpMode, type StepUpMode } from './step-up-gate.js';
import { MemoryStepUpUseStore } from './step-up-store.js';
import { scheduleBinding, toUserBinding } from './money-out-fields.js';

const SECRET = 'a-bank-step-up-money-out-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const SID = '22222222-2222-4222-8222-222222222222';
const SID2 = '23232323-2222-4222-8222-222222222222';
const FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWN_TO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN_TO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CARD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SCHEDULE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CLIENT = '12121212-1212-4212-8212-121212121212';
const BIZ_APPROVAL = '34343434-3434-4434-8434-343434343434';
const TRANSFER = 'transfer-0001';
const TRANSFER_2 = 'transfer-0002';
const START = '2026-11-01T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-step-up-money-out',
  });
}

/** A faithful stand-in for identity's same-person consume: CAS once, user + session + hash + expiry. */
class FakeIdentity implements ActionApprovalConsumer {
  now = 1_000_000;
  down = false;
  timeout = false;
  consumeCalls = 0;
  private readonly rows = new Map<
    string,
    {
      userId: string;
      sessionId: string;
      actionType: string;
      hash: string;
      expiresAt: number;
      consumed: boolean;
      kind: 'same_person' | 'four_eyes';
    }
  >();
  private n = 0;

  approve(
    actionType: string,
    fields: Record<string, string>,
    opts: { userId?: string; sessionId?: string; ttlMs?: number; hashOverride?: string; kind?: 'same_person' | 'four_eyes' } = {},
  ): string {
    const id = `approval-${++this.n}`;
    this.rows.set(id, {
      userId: opts.userId ?? USER,
      sessionId: opts.sessionId ?? SID,
      actionType,
      hash: opts.hashOverride ?? bankActionPayloadHash(actionType, fields),
      expiresAt: this.now + (opts.ttlMs ?? 300_000),
      consumed: false,
      kind: opts.kind ?? 'same_person',
    });
    return id;
  }

  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    this.consumeCalls += 1;
    if (this.down) throw new TypeError('fetch failed');
    if (this.timeout) throw new DOMException('The operation timed out', 'TimeoutError');
    const refuse = (code: string): never => {
      throw new ActionApprovalConsumeError(
        `identity refused consume (412) {"message":"x [action_approval.${code}]"}`,
        'action_approval.consume_failed',
      );
    };
    const row = this.rows.get(input.approvalId);
    if (!row) return refuse('not_found');
    if (this.now >= row.expiresAt) return refuse('expired');
    if (input.targetService !== 'svc-bank' || input.targetId !== row.actionType || input.operationId !== input.approvalId)
      return refuse('target_mismatch');
    if (row.hash !== input.payloadHash) return refuse('payload_mismatch');
    if (row.kind === 'same_person' && (row.userId !== input.principalUserId || row.sessionId !== input.principalSessionId))
      return refuse('not_requester');
    if (row.kind === 'four_eyes') return refuse('target_mismatch');
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
      createdAt: new Date(this.now).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      status: 'CONSUMED',
      operationId: input.approvalId,
      kind: 'same_person',
    };
  }
}

const space = (id: string, userId: string, assetId = 'USDT') => ({ id, userId, assetId, kind: 'named', name: 'n', archivedAt: null });

function fixture(mode: StepUpMode = 'required') {
  const identity = new FakeIdentity();
  const calls: string[] = [];
  const spaces = new Map([
    [FROM, space(FROM, USER)],
    [OWN_TO, space(OWN_TO, USER)],
    [FOREIGN_TO, space(FOREIGN_TO, OTHER)],
  ]);
  const posted = { ledgerTxId: 'tx-1', amount: '5' };
  const sched = { id: SCHEDULE, nextRunAt: new Date(START) };
  const cardRow = { id: CARD, userId: USER, status: 'frozen', assetId: 'USDT' };
  const mk = (name: string, result: unknown) =>
    vi.fn(async () => {
      calls.push(name);
      return result;
    });
  const spacesFind = vi.fn(async (id: string) => spaces.get(id) ?? null);
  const bank = {
    spaces: { get: async (id: string) => spaces.get(id), find: spacesFind },
    // Nobody here is a member of a shared pot (BK-acct-09): both transfer checks let the call through.
    sharedPots: { assertMayTakeOut: async () => undefined, assertMayAddTo: async () => undefined },
    transfers: {
      transfer: mk('transfers.transfer', posted),
      transferToUser: mk('transfers.transferToUser', posted),
      schedule: mk('transfers.schedule', sched),
      scheduleToUser: mk('transfers.scheduleToUser', sched),
      getSchedule: async () => ({ userId: USER }),
      cancelSchedule: mk('transfers.cancelSchedule', undefined),
      pauseSchedule: mk('transfers.pauseSchedule', { status: 'paused', nextRunAt: new Date(START) }),
    },
    business: {
      runPayroll: mk('business.runPayroll', {
        payrollId: 'p',
        accountId: ACCOUNT,
        fromSpaceId: FROM,
        assetId: 'USDT',
        ledgerTxId: 'tx',
        recipients: [],
        createdAt: new Date(START),
      }),
      proposeTransfer: mk('business.proposeTransfer', { kind: 'posted', transferId: 't', ledgerTxId: 'tx' }),
      approve: mk('business.approve', { transferId: 't', ledgerTxId: 'tx' }),
      addMember: mk('business.addMember', { accountId: ACCOUNT, userId: OTHER, role: 'checker' }),
      reject: mk('business.reject', undefined),
      cancel: mk('business.cancel', undefined),
    },
    cards: {
      card: async () => cardRow,
      issue: mk('cards.issue', {
        id: CARD,
        assetId: 'USDT',
        settlementAssetId: 'USDT',
        issuer: 'sim',
        simulated: true,
        panTail: '4242',
        status: 'active',
        cashbackBps: 0,
        perAuthorizationLimit: 10n ** 18n,
      }),
      setStatus: mk('cards.setStatus', { id: CARD, status: 'active' }),
    },
    ramps: {
      setWithdrawDestination: mk('ramps.setWithdrawDestination', { kind: 'crypto', ref: '0xabc' }),
    },
    personalPay: {
      send: vi.fn(async (input: { note?: string | null; reference?: string | null; requestId?: string | null }) => {
        calls.push('personalPay.send');
        return {
          ledgerTxId: 'tx-1',
          amount: '5',
          note: input.note ?? null,
          reference: input.reference ?? null,
          requestId: input.requestId ?? null,
        };
      }),
    },
  } as unknown as BankServices;
  const store = new MemoryStepUpUseStore();
  const stepUp = createStepUpGate({ mode, approvals: identity, store, clock: () => new Date(identity.now) });
  const router = createBankRouter(bank, { approvals: identity, stepUp });
  const caller = (p: Principal = principal()) => router.createCaller(signed(p));
  return { identity, calls, router, caller, spacesFind, bank, store, cardRow };
}

/** The field sets a client must hash: pinned here so the wire contract cannot drift silently. */
const toUserInput = { transferId: TRANSFER, fromSpaceId: FROM, toUserId: OTHER, amount: '5' };
const toUserFields = { actor: USER, transferId: TRANSFER, fromSpaceId: FROM, toUserId: OTHER, assetId: 'USDT', amount: '5' };
const TO_USER = 'bank.step_up.transfers.toUser';

describe('flag required: sends to other users', () => {
  it('pins the exact fields a client hashes for transfers.toUser', () => {
    expect(toUserBinding({ actor: USER, transferId: TRANSFER, fromSpaceId: FROM, toUserId: OTHER, assetId: 'USDT', amount: '5' })).toEqual({
      actionType: TO_USER,
      operationKey: TRANSFER,
      fields: toUserFields,
    });
  });

  it('transfers.toUser with a note reaches personalPay and not the space-transfer path', async () => {
    const f = fixture();
    const fields = { ...toUserFields, note: 'October rent' };
    const id = f.identity.approve(TO_USER, fields);
    await expect(f.caller().transfers.toUser({ ...toUserInput, note: 'October rent', stepUpApprovalId: id })).resolves.toMatchObject({
      ledgerTxId: 'tx-1',
      note: 'October rent',
      reference: null,
    });
    expect(f.calls).toEqual(['personalPay.send']);
  });

  it('adds a note and reference to the hash only when the transfer carries them', () => {
    expect(
      toUserBinding({
        actor: USER,
        transferId: TRANSFER,
        fromSpaceId: FROM,
        toUserId: OTHER,
        assetId: 'USDT',
        amount: '5',
        note: 'October rent',
        reference: 'INV-9',
      }).fields,
    ).toEqual({ ...toUserFields, note: 'October rent', reference: 'INV-9' });
  });

  it('refuses without an approval, and never reaches the service', async () => {
    const f = fixture();
    await expect(f.caller().transfers.toUser(toUserInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('bank.step_up_required'),
    });
    expect(f.calls).toEqual([]);
    expect(f.identity.consumeCalls).toBe(0);
  });

  it('accepts an approval for exactly this payload, then replays the same transferId without asking identity again', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
    expect(f.calls).toEqual(['personalPay.send', 'personalPay.send']);
    expect(f.identity.consumeCalls).toBe(1);
  });

  it.each([
    ['amount', { amount: '6' }],
    ['payee', { toUserId: 'someone-else' }],
    ['transferId', { transferId: TRANSFER_2 }],
  ])('a different %s than the one approved is a mismatch and posts nothing', async (_name, change) => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    await expect(f.caller().transfers.toUser({ ...toUserInput, ...change, stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    expect(f.calls).toEqual([]);
  });

  it('a different asset (the from space is in another asset) is a mismatch', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, { ...toUserFields, assetId: 'EUR' });
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    expect(f.calls).toEqual([]);
  });

  it('another session of the same user cannot replay a spent approval, even for the same transfer', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    await f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id });
    await expect(f.caller(principal({ sid: SID2 })).transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    expect(f.calls).toEqual(['personalPay.send']);
  });

  it('a timeout talking to identity is unavailable (503), and nothing posts', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    f.identity.timeout = true;
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('bank.step_up_unavailable'),
    });
    expect(f.calls).toEqual([]);
  });

  it('a spent approval cannot pay a different transfer', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    await f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id });
    await expect(f.caller().transfers.toUser({ ...toUserInput, transferId: TRANSFER_2, stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    expect(f.calls).toEqual(['personalPay.send']);
  });

  it('an approval spent elsewhere (consumed at identity, no use record) is refused as used', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    await f.identity.consume({
      approvalId: id,
      operationId: id,
      payloadHash: bankActionPayloadHash(TO_USER, toUserFields),
      targetService: 'svc-bank',
      targetId: TO_USER,
      expectedVersion: '1',
      principalUserId: USER,
      principalSessionId: SID,
    });
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_used'),
    });
    expect(f.calls).toEqual([]);
  });

  it('refuses an expired approval, another user, another session and an unknown id', async () => {
    const f = fixture();
    const expired = f.identity.approve(TO_USER, toUserFields, { ttlMs: 1000 });
    f.identity.now += 2000;
    const otherUser = f.identity.approve(TO_USER, toUserFields, { userId: OTHER });
    const otherSession = f.identity.approve(TO_USER, toUserFields, { sessionId: SID2 });
    for (const id of [expired, otherUser, otherSession, 'does-not-exist']) {
      await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
        message: expect.stringContaining('bank.step_up_required'),
      });
    }
    expect(f.calls).toEqual([]);
  });

  it('refuses a four-eyes approval on a step-up door', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields, { kind: 'four_eyes' });
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toBeDefined();
    expect(f.calls).toEqual([]);
  });

  it('fails closed when identity is unreachable or not wired', async () => {
    const f = fixture();
    const id = f.identity.approve(TO_USER, toUserFields);
    f.identity.down = true;
    await expect(f.caller().transfers.toUser({ ...toUserInput, stepUpApprovalId: id })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('bank.step_up_unavailable'),
    });
    expect(f.calls).toEqual([]);

    const unwired = createBankRouter(f.bank, {
      stepUp: createStepUpGate({
        mode: 'required',
        approvals: { consume: () => Promise.reject(new ActionApprovalConsumeError('unwired', 'action_approval.identity_unwired')) },
      }),
    });
    await expect(
      unwired.createCaller(signed(principal())).transfers.toUser({ ...toUserInput, stepUpApprovalId: id }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('a trade:withdraw bearer is no substitute for an approval', async () => {
    const f = fixture();
    const withdraw = principal({ scopes: ['bank:read', 'bank:write', 'trade:withdraw'], mfa: true });
    await expect(f.caller(withdraw).transfers.toUser(toUserInput)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    expect(f.calls).toEqual([]);
  });

  it('sending to yourself by user id does not prompt', async () => {
    const f = fixture();
    await expect(f.caller().transfers.toUser({ ...toUserInput, toUserId: USER })).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
  });
});

describe('flag required: transfers.create / schedule / scheduleToUser', () => {
  const createInput = { transferId: TRANSFER, fromSpaceId: FROM, toSpaceId: FOREIGN_TO, amount: '5' };

  it('a move between your own spaces never prompts', async () => {
    const f = fixture();
    await expect(f.caller().transfers.create({ ...createInput, toSpaceId: OWN_TO })).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
    expect(f.calls).toEqual(['transfers.transfer']);
    expect(f.identity.consumeCalls).toBe(0);
  });

  it('to another user (or an unknown space) it needs an approval for that exact destination', async () => {
    const f = fixture();
    const fields = { actor: USER, transferId: TRANSFER, fromSpaceId: FROM, toSpaceId: FOREIGN_TO, assetId: 'USDT', amount: '5' };
    await expect(f.caller().transfers.create(createInput)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    // an id that does not exist is indistinguishable from a foreign one: it asks for the step-up too
    await expect(f.caller().transfers.create({ ...createInput, toSpaceId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const id = f.identity.approve('bank.step_up.transfers.create', fields);
    await expect(f.caller().transfers.create({ ...createInput, stepUpApprovalId: id })).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
    const wrongPayee = f.identity.approve('bank.step_up.transfers.create', { ...fields, toSpaceId: OWN_TO });
    await expect(f.caller().transfers.create({ ...createInput, stepUpApprovalId: wrongPayee })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
  });

  it('standing orders to another person are approved at creation, binding cadence and dates; cancel and pause never prompt', async () => {
    const f = fixture();
    const sched = {
      scheduleId: SCHEDULE,
      fromSpaceId: FROM,
      toSpaceId: FOREIGN_TO,
      amount: '5',
      cadence: 'monthly' as const,
      startsAt: START,
    };
    await expect(f.caller().transfers.schedule(sched)).rejects.toMatchObject({ message: expect.stringContaining('bank.step_up_required') });
    const bind = scheduleBinding({
      actor: USER,
      scheduleId: SCHEDULE,
      fromSpaceId: FROM,
      toSpaceId: FOREIGN_TO,
      assetId: 'USDT',
      amount: '5',
      cadence: 'monthly',
      startsAt: START,
      endsAt: undefined,
    });
    const id = f.identity.approve(bind.actionType, bind.fields);
    await expect(f.caller().transfers.schedule({ ...sched, cadence: 'daily', stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    await expect(f.caller().transfers.schedule({ ...sched, stepUpApprovalId: id })).resolves.toMatchObject({ id: SCHEDULE });
    await expect(f.caller().transfers.cancel({ scheduleId: SCHEDULE })).resolves.toEqual({ cancelled: true });
    await expect(f.caller().transfers.pause({ scheduleId: SCHEDULE })).resolves.toMatchObject({ status: 'paused' });
  });

  it('scheduleToUser needs one; to yourself it does not', async () => {
    const f = fixture();
    const input = { scheduleId: SCHEDULE, fromSpaceId: FROM, toUserId: OTHER, amount: '5', cadence: 'weekly' as const, startsAt: START };
    await expect(f.caller().transfers.scheduleToUser(input)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const id = f.identity.approve('bank.step_up.transfers.scheduleToUser', {
      actor: USER,
      scheduleId: SCHEDULE,
      fromSpaceId: FROM,
      toUserId: OTHER,
      assetId: 'USDT',
      amount: '5',
      cadence: 'weekly',
      startsAt: START,
      endsAt: '',
    });
    await expect(f.caller().transfers.scheduleToUser({ ...input, stepUpApprovalId: id })).resolves.toMatchObject({ id: SCHEDULE });
    await expect(f.caller().transfers.scheduleToUser({ ...input, toUserId: USER })).resolves.toMatchObject({ id: SCHEDULE });
  });
});

describe('flag required: business and cards', () => {
  it('runPayroll binds every line (order-insensitive) and the asset', async () => {
    const f = fixture();
    const recipients = [
      { toSpaceId: FOREIGN_TO, amount: '3' },
      { toSpaceId: OWN_TO, amount: '2' },
    ];
    const input = { payrollId: SCHEDULE, accountId: ACCOUNT, fromSpaceId: FROM, recipients };
    await expect(f.caller().business.runPayroll(input)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const lines = JSON.stringify([
      [OWN_TO, '2'],
      [FOREIGN_TO, '3'],
    ]);
    const fields = { actor: USER, payrollId: SCHEDULE, accountId: ACCOUNT, fromSpaceId: FROM, assetId: 'USDT', lines };
    const good = f.identity.approve('bank.step_up.business.runPayroll', fields);
    const changed = f.identity.approve('bank.step_up.business.runPayroll', {
      ...fields,
      lines: JSON.stringify([
        [OWN_TO, '2'],
        [FOREIGN_TO, '4'],
      ]),
    });
    await expect(f.caller().business.runPayroll({ ...input, stepUpApprovalId: changed })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    await expect(f.caller().business.runPayroll({ ...input, stepUpApprovalId: good })).resolves.toMatchObject({ ledgerTxId: 'tx' });
  });

  it('proposeTransfer, approve and addMember each need one; reject and cancel never do', async () => {
    const f = fixture();
    const propose = { accountId: ACCOUNT, fromSpaceId: FROM, toSpaceId: OWN_TO, amount: '1', clientId: CLIENT };
    await expect(f.caller().business.proposeTransfer(propose)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    await expect(f.caller().business.approve({ approvalId: BIZ_APPROVAL })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    const member = { accountId: ACCOUNT, userId: OTHER, role: 'checker' as const };
    await expect(f.caller().business.addMember(member)).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    expect(f.calls).toEqual([]);

    const p = f.identity.approve('bank.step_up.business.proposeTransfer', {
      actor: USER,
      clientId: CLIENT,
      accountId: ACCOUNT,
      fromSpaceId: FROM,
      toSpaceId: OWN_TO,
      assetId: 'USDT',
      amount: '1',
    });
    const a = f.identity.approve('bank.step_up.business.approve', { actor: USER, approvalId: BIZ_APPROVAL });
    const m = f.identity.approve('bank.step_up.business.addMember', { actor: USER, accountId: ACCOUNT, userId: OTHER, role: 'checker' });
    await f.caller().business.proposeTransfer({ ...propose, stepUpApprovalId: p });
    await f.caller().business.approve({ approvalId: BIZ_APPROVAL, stepUpApprovalId: a });
    await f.caller().business.addMember({ ...member, stepUpApprovalId: m });
    // a different role is a different payload
    const asAdmin = f.identity.approve('bank.step_up.business.addMember', {
      actor: USER,
      accountId: ACCOUNT,
      userId: OTHER,
      role: 'checker',
    });
    await expect(f.caller().business.addMember({ ...member, role: 'admin', stepUpApprovalId: asAdmin })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    await expect(f.caller().business.reject({ approvalId: BIZ_APPROVAL })).resolves.toEqual({ ok: true });
    await expect(f.caller().business.cancel({ approvalId: BIZ_APPROVAL })).resolves.toEqual({ ok: true });
    expect(f.calls).toEqual(['business.proposeTransfer', 'business.approve', 'business.addMember', 'business.reject', 'business.cancel']);
  });

  it('unfreeze and issue need one; freeze and close never do; unfreezing twice with one approval is refused', async () => {
    const f = fixture();
    await expect(f.caller().cards.setStatus({ cardId: CARD, status: 'active' })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_required'),
    });
    await expect(f.caller().cards.setStatus({ cardId: CARD, status: 'frozen' })).resolves.toMatchObject({ id: CARD });
    await expect(f.caller().cards.setStatus({ cardId: CARD, status: 'closed' })).resolves.toMatchObject({ id: CARD });
    const id = f.identity.approve('bank.step_up.cards.unfreeze', { actor: USER, cardId: CARD, fromStatus: 'frozen', status: 'active' });
    await expect(f.caller().cards.setStatus({ cardId: CARD, status: 'active', stepUpApprovalId: id })).resolves.toMatchObject({ id: CARD });
    // no replay for state flips: the same approval cannot unfreeze the card a second time
    await expect(f.caller().cards.setStatus({ cardId: CARD, status: 'active', stepUpApprovalId: id })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_used'),
    });

    const issue = { cardId: CARD, assetId: 'USDT', perAuthorizationLimit: '10' };
    await expect(f.caller().cards.issue(issue)).rejects.toMatchObject({ message: expect.stringContaining('bank.step_up_required') });
    const bigger = f.identity.approve('bank.step_up.cards.issue', {
      actor: USER,
      cardId: CARD,
      assetId: 'USDT',
      settlementAssetId: '',
      cashbackBps: '',
      perAuthorizationLimit: '1000',
      cardType: 'virtual',
      shippingAddress: '',
    });
    await expect(f.caller().cards.issue({ ...issue, stepUpApprovalId: bigger })).rejects.toMatchObject({
      message: expect.stringContaining('bank.step_up_mismatch'),
    });
    const ok = f.identity.approve('bank.step_up.cards.issue', {
      actor: USER,
      cardId: CARD,
      assetId: 'USDT',
      settlementAssetId: '',
      cashbackBps: '',
      perAuthorizationLimit: '10',
      cardType: 'virtual',
      shippingAddress: '',
    });
    await expect(f.caller().cards.issue({ ...issue, stepUpApprovalId: ok })).resolves.toMatchObject({ id: CARD });
  });
});

describe('the existing trade:withdraw doors are untouched', () => {
  const destination = { kind: 'crypto', ref: '0x1111111111111111111111111111111111111111' } as const;

  it('an approval does not open setWithdrawDestination; trade:withdraw still does, with or without the flag', async () => {
    for (const mode of ['required', 'off'] as const) {
      const f = fixture(mode);
      const id = f.identity.approve(TO_USER, toUserFields);
      const plain = f.caller();
      await expect(plain.ramps.setWithdrawDestination({ ...destination, stepUpApprovalId: id } as never)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const withdraw = f.caller(principal({ scopes: ['bank:read', 'bank:write', 'trade:withdraw'], mfa: true }));
      await expect(withdraw.ramps.setWithdrawDestination(destination)).resolves.toMatchObject({ kind: 'crypto' });
      expect(f.identity.consumeCalls).toBe(0);
    }
  });
});

describe("flag off (the default): today's behaviour, byte for byte", () => {
  it('every door runs without an approval, identity is never asked and no extra space lookups happen', async () => {
    const f = fixture('off');
    await f.caller().transfers.toUser(toUserInput);
    await f.caller().transfers.create({ transferId: TRANSFER, fromSpaceId: FROM, toSpaceId: FOREIGN_TO, amount: '5' });
    await f.caller().transfers.scheduleToUser({
      scheduleId: SCHEDULE,
      fromSpaceId: FROM,
      toUserId: OTHER,
      amount: '5',
      cadence: 'daily',
      startsAt: START,
    });
    await f.caller().cards.setStatus({ cardId: CARD, status: 'active' });
    await f.caller().business.addMember({ accountId: ACCOUNT, userId: OTHER, role: 'checker' });
    await f.caller().business.runPayroll({
      payrollId: SCHEDULE,
      accountId: ACCOUNT,
      fromSpaceId: FROM,
      recipients: [{ toSpaceId: FOREIGN_TO, amount: '1' }],
    });
    expect(f.identity.consumeCalls).toBe(0);
    // only `create`'s own destination gate looks the space up; the step-up path adds none
    expect(f.spacesFind).toHaveBeenCalledTimes(1);
  });

  it('a router built without a gate behaves the same', async () => {
    const f = fixture('off');
    const plain = createBankRouter(f.bank);
    await expect(plain.createCaller(signed(principal())).transfers.toUser(toUserInput)).resolves.toMatchObject({ ledgerTxId: 'tx-1' });
  });
});

describe('BANK_STEP_UP_MONEY_OUT value', () => {
  it('accepts off and required, defaults to off, and refuses anything else', () => {
    expect(parseStepUpMode(undefined)).toBe('off');
    expect(parseStepUpMode('off')).toBe('off');
    expect(parseStepUpMode('required')).toBe('required');
    for (const bad of ['', 'on', 'true', 'REQUIRED', 'optional', ' required']) {
      expect(() => parseStepUpMode(bad)).toThrow(/BANK_STEP_UP_MONEY_OUT/);
    }
  });
});
