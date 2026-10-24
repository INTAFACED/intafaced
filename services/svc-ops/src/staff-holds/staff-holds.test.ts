import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  staffHoldConfirmFields,
  staffHoldReleaseFields,
  staffHoldTargetId,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  parseAmount,
  recipes,
  staffHoldAccount,
  staffHoldConfirmAccount,
  userAvailable,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { approvalPayloadHash } from '../operator-desks.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { StaffHoldDesk, type StaffHoldLedger, type StaffHoldSettings } from './desk.js';
import { MemoryStaffHoldStore, type StaffHoldStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const START = Date.parse('2026-10-24T08:00:00.000Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: FOUNDER,
    userId: FOUNDER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

/** A stand-in for identity: an approval names one action, hold and payload, is approved by a second founder, and is spent once. */
function identity() {
  const rows = new Map<string, { approval: ActionApproval; approved: boolean; spent: boolean }>();
  let n = 0;
  const reject = (code: string): never => {
    throw new Error(code);
  };
  return {
    spent: () => [...rows.values()].filter((r) => r.spent).length,
    propose(actionType: string, holdNo: string, fields: Record<string, string>, approved = true) {
      n += 1;
      const approval: ActionApproval = {
        approvalId: `ap_${n}`,
        operationId: `op_${n}`,
        payloadHash: approvalPayloadHash(actionType, fields),
        targetService: 'svc-ops',
        targetId: staffHoldTargetId(holdNo),
        expectedVersion: '1',
        actionType,
        requesterId: FOUNDER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'p1',
        createdAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 600_000).toISOString(),
        status: 'CONSUMED',
      };
      rows.set(approval.approvalId, { approval, approved, spent: false });
      return { approvalId: approval.approvalId, operationId: approval.operationId };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId) ?? reject('action_approval.not_found');
      // Only a second founder's approval makes it spendable: the asker alone cannot.
      if (!row!.approved) reject('action_approval.not_approved');
      if (row!.spent) {
        // A retry under the same request id gets the spent row back (identity's consume idempotency).
        if (input.requestId && input.requestId === (row as { requestId?: string }).requestId) return row!.approval;
        reject('action_approval.consumed');
      }
      if (input.payloadHash !== row!.approval.payloadHash) reject('action_approval.payload_mismatch');
      if (input.targetId !== row!.approval.targetId || input.operationId !== row!.approval.operationId)
        reject('action_approval.target_mismatch');
      row!.spent = true;
      (row as { requestId?: string }).requestId = input.requestId;
      return row!.approval;
    },
  };
}

/** A ledger whose next posts can be made to fail the way a real one does. */
class TestLedger implements StaffHoldLedger {
  readonly book = new MemoryLedger();
  frozen = false;
  /** Post, then lose the reply this many times. */
  loseReplies = 0;
  /** Fail before sending this many times (the reply proves nothing either way). */
  timeouts = 0;
  posts = 0;

  async post(request: PostRequest): Promise<LedgerTx> {
    this.posts += 1;
    if (this.timeouts > 0) {
      this.timeouts -= 1;
      throw new Error('svc-ledger timed out');
    }
    if (this.frozen) throw new LedgerError('ledger is frozen', 'ledger.frozen');
    const tx = await this.book.post(request);
    if (this.loseReplies > 0) {
      this.loseReplies -= 1;
      throw new Error('socket hang up');
    }
    return tx;
  }

  getTxByKey(key: string) {
    return this.book.getTxByKey(key);
  }

  async balance(account: Parameters<MemoryLedger['balance']>[0]) {
    return formatAmount((await this.book.balance(account)).amount);
  }
}

const SETTINGS: StaffHoldSettings = { confirmAccount: 'held-funds', expiryMaxHours: 24 };

async function build(options: { settings?: StaffHoldSettings; store?: StaffHoldStore | null; ledger?: TestLedger | null } = {}) {
  const ids = identity();
  const ledger = options.ledger === undefined ? new TestLedger() : options.ledger;
  if (ledger) {
    await ledger.book.post(
      recipes.deposit({ userId: CUSTOMER, assetId: 'USD', amount: parseAmount('100'), rail: 'bank-sandbox', railRef: 'dep-1' }),
    );
  }
  let clock = START;
  const desk = new StaffHoldDesk({
    store: options.store === null ? undefined : (options.store ?? new MemoryStaffHoldStore()),
    ledger: ledger ?? undefined,
    approvals: ids,
    settings: options.settings ?? SETTINGS,
    now: () => new Date(clock),
  });
  const router = createOpsRouter(new OpsService(), undefined, { approvals: ids, staffHolds: desk });
  return {
    ids,
    ledger: ledger!,
    desk,
    advance: (ms: number) => {
      clock += ms;
    },
    caller: (scopes = ['admin:read', 'admin:treasury']) => signed(scopes).then((ctx) => router.createCaller(ctx)),
  };
}

const available = () => userAvailable(CUSTOMER, 'USD');
const held = (holdNo: string) => staffHoldAccount(CUSTOMER, 'USD', holdNo);
const place = (amount = '40.00', extra: { expiresInHours?: number | null; idempotencyKey?: string } = {}) => ({
  userId: CUSTOMER,
  assetId: 'USD',
  amount,
  reason: 'suspected account takeover',
  idempotencyKey: extra.idempotencyKey ?? 'console:place:0001',
  ...(extra.expiresInHours !== undefined ? { expiresInHours: extra.expiresInHours } : {}),
});
const release = (ids: ReturnType<typeof identity>, holdNo: string, amount: string, approved = true) => ({
  holdNo,
  amount,
  ...ids.propose('ops.hold.release', holdNo, staffHoldReleaseFields(holdNo, amount.replace(/\.?0+$/, '')), approved),
});
const confirm = (ids: ReturnType<typeof identity>, holdNo: string) => ({
  holdNo,
  ...ids.propose('ops.hold.confirm', holdNo, staffHoldConfirmFields(holdNo)),
});

describe('staff holds on funds (OPS-accounts-desk-01)', () => {
  it('a hold of 40.00 on 100.00 leaves 60.00 available and 100.00 in total; a retry of the place posts once', async () => {
    const { caller, ledger } = await build();
    const c = await caller();
    const first = await c.staffHolds.place(place());
    expect(first).toMatchObject({
      outcome: 'done',
      hold: { holdNo: '1', amount: '40', remaining: '40', state: 'active', placedBy: FOUNDER },
    });
    expect(first.hold.movements).toMatchObject([{ kind: 'place', status: 'posted', idempotencyKey: 'ops:hold:1', cause: 'staff' }]);
    expect(await ledger.balance(available())).toBe('60');
    expect(await ledger.balance(held('1'))).toBe('40');
    expect(await c.staffHolds.place(place())).toMatchObject({ outcome: 'replayed', hold: { holdNo: '1' } });
    expect(ledger.posts).toBe(1);
    await expect(c.staffHolds.place({ ...place(), amount: '41' })).rejects.toThrow(/ops\.idempotency_conflict/);
  });

  it('a hold above what is available is refused by the ledger, nothing is held, and the retry gives the same refusal', async () => {
    const { caller, ledger } = await build();
    const c = await caller();
    await expect(c.staffHolds.place(place('100.01'))).rejects.toThrow(/ledger\.insufficient_funds/);
    await expect(c.staffHolds.place(place('100.01'))).rejects.toThrow(/ledger\.insufficient_funds/);
    expect(await ledger.balance(available())).toBe('100');
    const listed = await c.staffHolds.list({ userId: CUSTOMER });
    expect(listed.holds).toMatchObject([{ holdNo: '1', state: 'refused', remaining: '0' }]);
    expect(ledger.posts).toBe(1);
  });

  it('a release needs a second founder; with one, 15.00 of 40.00 leaves the hold partially released with 25.00', async () => {
    const { caller, ledger, ids } = await build();
    const c = await caller();
    await c.staffHolds.place(place());
    await expect(c.staffHolds.release(release(ids, '1', '15.00', false))).rejects.toThrow(/action_approval\.not_approved/);
    expect(await ledger.balance(held('1'))).toBe('40');

    const input = release(ids, '1', '15.00');
    const done = await c.staffHolds.release(input);
    expect(done).toMatchObject({ outcome: 'done', hold: { state: 'partially_released', remaining: '25' } });
    expect(done.hold.movements[1]).toMatchObject({
      kind: 'release',
      no: '1',
      amount: '15',
      idempotencyKey: 'ops:hold-release:1:1',
      cause: 'approval',
      approverId: APPROVER,
    });
    expect(await ledger.balance(available())).toBe('75');
    expect(await ledger.balance(held('1'))).toBe('25');
    expect(await c.staffHolds.release(input)).toMatchObject({ outcome: 'replayed' });
    expect(ids.spent()).toBe(1);
    expect(ledger.posts).toBe(2);
  });

  it('a release above what is left refuses before the approval is spent', async () => {
    const { caller, ids } = await build();
    const c = await caller();
    await c.staffHolds.place(place());
    await expect(c.staffHolds.release(release(ids, '1', '40.01'))).rejects.toThrow(/ops\.hold_amount_exceeds_remaining/);
    expect(ids.spent()).toBe(0);
  });

  it('confirm debits what is left once, to the owner-named account', async () => {
    const { caller, ledger, ids } = await build();
    const c = await caller();
    await c.staffHolds.place(place());
    await c.staffHolds.release(release(ids, '1', '15'));
    const input = confirm(ids, '1');
    const done = await c.staffHolds.confirm(input);
    expect(done).toMatchObject({ outcome: 'done', hold: { state: 'confirmed', remaining: '0' } });
    expect(done.hold.movements[2]).toMatchObject({ kind: 'confirm', amount: '25', idempotencyKey: 'ops:hold-confirm:1:1' });
    expect(await ledger.balance(staffHoldConfirmAccount('held-funds', 'USD'))).toBe('25');
    expect(await ledger.balance(held('1'))).toBe('0');
    expect(await ledger.balance(available())).toBe('75');
    expect(await c.staffHolds.confirm(input)).toMatchObject({ outcome: 'replayed' });
    await expect(c.staffHolds.release(release(ids, '1', '1'))).rejects.toThrow(/ops\.hold_state_illegal/);
  });

  it('with no confirm account named, confirm refuses owner.decision before the approval is spent and nothing posts', async () => {
    const { caller, ledger, ids } = await build({ settings: { confirmAccount: null, expiryMaxHours: 24 } });
    const c = await caller();
    await c.staffHolds.place(place());
    await expect(c.staffHolds.confirm(confirm(ids, '1'))).rejects.toThrow(/owner\.decision/);
    expect(ids.spent()).toBe(0);
    expect(await ledger.balance(held('1'))).toBe('40');
    expect((await c.staffHolds.list({ userId: CUSTOMER })).settings).toEqual({ expiryMaxHours: 24, confirmAccountSet: false });
  });

  it('a release and a confirm asked for at the same moment: exactly one posts', async () => {
    const { caller, ledger, ids } = await build();
    const c = await caller();
    await c.staffHolds.place(place('25'));
    const outcomes = await Promise.allSettled([c.staffHolds.release(release(ids, '1', '25')), c.staffHolds.confirm(confirm(ids, '1'))]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/ops\.hold_state_illegal/);
    expect(await ledger.balance(held('1'))).toBe('0');
    expect(ledger.posts).toBe(2);
    expect(ids.spent()).toBe(1);
  });

  it('a hold with an expiry releases itself at the stored time, under the next release number, without an approver', async () => {
    const { caller, ledger, desk, ids, advance } = await build();
    const c = await caller();
    const placed = await c.staffHolds.place(place('40', { expiresInHours: 2 }));
    expect(placed.hold.expiresAt).toBe('2026-10-24T10:00:00.000Z');
    await c.staffHolds.release(release(ids, '1', '15'));
    advance(60 * 60_000);
    expect(await desk.expireDue()).toBe(0);
    advance(60 * 60_000);
    expect(await desk.expireDue()).toBe(1);
    expect(await desk.expireDue()).toBe(0);
    const [hold] = (await c.staffHolds.list({ userId: CUSTOMER })).holds;
    expect(hold).toMatchObject({ state: 'expired', remaining: '0' });
    expect(hold!.movements[2]).toMatchObject({ kind: 'release', no: '2', amount: '25', cause: 'expiry', approverId: null });
    expect(await ledger.balance(available())).toBe('100');
  });

  it('an expiry needs the owner’s longest expiry: blank refuses ops.hold_expiry_unset, longer refuses too long', async () => {
    const unset = await build({ settings: { confirmAccount: 'held-funds', expiryMaxHours: null } });
    const c = await unset.caller();
    await expect(c.staffHolds.place(place('40', { expiresInHours: 1 }))).rejects.toThrow(/ops\.hold_expiry_unset/);
    expect(await c.staffHolds.place(place('40', { expiresInHours: null }))).toMatchObject({ hold: { expiresAt: null } });
    const short = await build();
    await expect((await short.caller()).staffHolds.place(place('40', { expiresInHours: 25 }))).rejects.toThrow(/ops\.hold_expiry_too_long/);
    expect(unset.ledger.posts).toBe(1);
  });

  it('under the posting freeze the place waits as pending_retry under the same key, and posts once the freeze lifts', async () => {
    const { caller, ledger, desk } = await build();
    ledger.frozen = true;
    const c = await caller();
    const waiting = await c.staffHolds.place(place());
    expect(waiting).toMatchObject({ outcome: 'settling', hold: { state: 'placing' } });
    expect(waiting.hold.movements[0]).toMatchObject({ status: 'pending_retry', code: 'ledger.frozen', idempotencyKey: 'ops:hold:1' });
    await expect(c.staffHolds.release(release(identity(), '1', '1'))).rejects.toThrow(/ops\.hold_state_illegal/);
    ledger.frozen = false;
    expect(await desk.resolve()).toBe(1);
    const [hold] = (await c.staffHolds.list({ userId: CUSTOMER })).holds;
    expect(hold).toMatchObject({ state: 'active', movements: [{ status: 'posted', idempotencyKey: 'ops:hold:1' }] });
    expect(await ledger.balance(held('1'))).toBe('40');
  });

  it('a lost reply keeps the movement settling; resolving re-sends the same key and the ledger holds once', async () => {
    const { caller, ledger, desk, ids } = await build();
    const c = await caller();
    await c.staffHolds.place(place());
    ledger.loseReplies = 1;
    const lost = await c.staffHolds.release(release(ids, '1', '15'));
    expect(lost).toMatchObject({ outcome: 'settling', hold: { state: 'active', remaining: '40' } });
    expect(await ledger.balance(held('1'))).toBe('25');
    await desk.resolve();
    expect((await c.staffHolds.list({ userId: CUSTOMER })).holds[0]).toMatchObject({ state: 'partially_released', remaining: '25' });
    expect(await ledger.balance(held('1'))).toBe('25');
    expect(await ledger.balance(available())).toBe('75');
  });

  it('a post that never landed is settled from the ledger’s book once the in-flight bound has passed', async () => {
    const { caller, ledger, desk, advance } = await build();
    ledger.timeouts = 2;
    const c = await caller();
    expect(await c.staffHolds.place(place())).toMatchObject({ outcome: 'settling' });
    await desk.resolve();
    expect((await c.staffHolds.list({ userId: CUSTOMER })).holds[0]).toMatchObject({ state: 'placing' });
    advance(8 * 60_000);
    await desk.resolve();
    const [hold] = (await c.staffHolds.list({ userId: CUSTOMER })).holds;
    expect(hold).toMatchObject({ state: 'refused', movements: [{ status: 'refused', code: 'ledger.post_lost' }] });
    expect(await ledger.balance(available())).toBe('100');
  });

  it('place, release and confirm need admin:treasury; the list needs admin:read', async () => {
    const { caller } = await build();
    const write = await caller(['admin:read', 'admin:write']);
    await expect(write.staffHolds.place(place())).rejects.toThrow(/admin:treasury|FORBIDDEN|scope/i);
    expect((await write.staffHolds.list({ userId: CUSTOMER })).holds).toEqual([]);
  });

  it('with no storage or no ledger, every call says which is missing and nothing posts', async () => {
    const bare = await build({ store: null });
    await expect((await bare.caller()).staffHolds.list({ userId: CUSTOMER })).rejects.toThrow(/ops\.hold_storage_unconfigured/);
    const unwired = await build({ ledger: null });
    await expect((await unwired.caller()).staffHolds.place(place())).rejects.toThrow(/ops\.hold_ledger_unconfigured/);
  });
});
