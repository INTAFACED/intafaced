import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { opsReversalApprovalFields, opsReversalTargetId } from '@intafaced/contracts/ops-ledger-reversals';
import type { OperatorReverseCall } from '@intafaced/ledger-client/operator-reverse';
import { approvalPayloadHash } from '../operator-desks.js';
import { LedgerReversalDesk } from './desk.js';
import type { ReversalLedger, ReverseOutcome } from './ledger.js';
import { MemoryReversalStore } from './store.js';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVERSING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = Date.parse('2026-11-24T08:00:00.000Z');

/** A stand-in for identity: an approval names one request and payload, is given by `approver`, and is spent once. */
function identity() {
  const rows = new Map<string, { requestNo: string; hash: string; approver: string; spent: boolean }>();
  let n = 0;
  return {
    consumed: () => [...rows.values()].filter((r) => r.spent).length,
    propose(requestNo: string, reason: string, caseRef: string, approver = APPROVER, original = ORIGINAL) {
      n += 1;
      const hash = approvalPayloadHash(
        'ops.ledger.reverse',
        opsReversalApprovalFields({ requestNo, originalTxId: original, reason, caseRef }),
      );
      rows.set(`ap_${n}`, { requestNo, hash, approver, spent: false });
      return { approvalId: `ap_${n}`, operationId: `op_${n}` };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      if (!row) throw new Error('action_approval.not_found');
      if (row.hash !== input.payloadHash) throw new Error('action_approval.payload_mismatch');
      if (row.spent) throw new Error('action_approval.consumed');
      row.spent = true;
      return {
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: row.hash,
        targetService: 'svc-ops',
        targetId: opsReversalTargetId(row.requestNo),
        expectedVersion: '1',
        actionType: 'ops.ledger.reverse',
        requesterId: FOUNDER,
        approverId: row.approver,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 600_000).toISOString(),
        status: 'CONSUMED',
      };
    },
  };
}

/**
 * A stand-in for svc-ledger's `operatorReverse` door, as `reversal.rs` answers: one booking per key (the same key replays
 * it), one reversal per original (another key is refused naming the first). `next` scripts the answer of the next send
 * (`lost`: the booking happens and the reply is lost).
 */
function book() {
  const byKey = new Map<string, string>();
  const firstByOriginal = new Map<string, string>();
  const sent: Array<{ call: OperatorReverseCall; key: string }> = [];
  let scripted: Array<'lost' | 'frozen' | 'insufficient' | 'unreachable'> = [];
  let n = 0;
  const ledger: ReversalLedger = {
    async reverse(call, key): Promise<ReverseOutcome> {
      sent.push({ call, key });
      const step = scripted.shift();
      if (step === 'frozen') return { kind: 'retry', code: 'ledger.frozen' };
      if (step === 'insufficient') return { kind: 'refused', code: 'ledger.insufficient_funds', reversedBy: null };
      if (step === 'unreachable') return { kind: 'retry', code: 'ledger.reply_lost' };
      const first = firstByOriginal.get(call.originalTxId);
      if (first && first !== key) return { kind: 'refused', code: 'ledger.reversal_already_reversed', reversedBy: byKey.get(first)! };
      if (!byKey.has(key)) {
        n += 1;
        byKey.set(key, n === 1 ? REVERSING : `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`);
        firstByOriginal.set(call.originalTxId, key);
      }
      if (step === 'lost') return { kind: 'retry', code: 'ledger.reply_lost' };
      return { kind: 'posted', txId: byKey.get(key)! };
    },
  };
  return {
    ledger,
    sent,
    bookings: () => byKey.size,
    next(...steps: typeof scripted) {
      scripted = steps;
    },
    /** Another reversal of `original` already in the book, booked by a key this desk never sent. */
    seed(original: string, key: string, txId: string) {
      byKey.set(key, txId);
      firstByOriginal.set(original, key);
    },
  };
}

function setup(options: { ledger?: boolean; store?: boolean } = {}) {
  const store = new MemoryReversalStore();
  const ids = identity();
  const ledger = book();
  let now = START;
  const desk = new LedgerReversalDesk({
    store: options.store === false ? undefined : store,
    ledger: options.ledger === false ? undefined : ledger.ledger,
    approvals: ids,
    now: () => new Date(now),
  });
  return { desk, store, ids, ledger, tick: (ms: number) => (now += ms) };
}

const ask = { originalTxId: ORIGINAL, reason: 'LOCAL TEST posted to the wrong account', caseRef: 'CASE-7' };

async function refusal(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error('expected a refusal');
}

describe('operator reversal desk (OPS-ledger-desk-02)', () => {
  it('a request writes the intent row and nothing else: nothing posts until a different person approves', async () => {
    const { desk, store, ledger, ids } = setup();
    const intent = await desk.request(FOUNDER, ask);
    expect(intent).toMatchObject({
      requestNo: '1',
      state: 'intent',
      ordinal: '1',
      ledgerKey: `ops:reversal:${ORIGINAL}:1`,
      requestedBy: FOUNDER,
      approverId: null,
      reversingTxId: null,
      attempts: 0,
    });
    expect(ledger.sent).toHaveLength(0);
    expect(ids.consumed()).toBe(0);
    // Asking again with the same words is the same intent, not a second one.
    expect(await desk.request(FOUNDER, ask)).toMatchObject({ requestNo: '1', state: 'intent' });
    expect(store.all()).toHaveLength(1);
  });

  it('no approval, a refused approval or an approval of other words posts nothing and leaves the row at intent', async () => {
    const { desk, ledger, ids } = setup();
    await desk.request(FOUNDER, ask);
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '1', approvalId: 'ap_404', operationId: 'op_404' }))).code).toBe(
      'action_approval.identity_unwired',
    );
    const other = ids.propose('1', 'a different reason', ask.caseRef);
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '1', ...other }))).message).toContain('payload_mismatch');
    expect(ledger.sent).toHaveLength(0);
    expect(await desk.get('1')).toMatchObject({ state: 'intent', approverId: null, attempts: 0 });
  });

  it('the requester approving their own request is refused action_approval.same_person, and nothing posts', async () => {
    const { desk, ledger, ids } = setup();
    await desk.request(FOUNDER, ask);
    const own = ids.propose('1', ask.reason, ask.caseRef, FOUNDER);
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '1', ...own }))).code).toBe('action_approval.same_person');
    expect(ledger.sent).toHaveLength(0);
    expect((await desk.get('1')).state).toBe('intent');
  });

  it('only the requester runs it', async () => {
    const { desk, ledger, ids } = setup();
    await desk.request(FOUNDER, ask);
    const approval = ids.propose('1', ask.reason, ask.caseRef);
    expect((await refusal(desk.execute(APPROVER, { requestNo: '1', ...approval }))).code).toBe('ops.reversal_requester_only');
    expect(ids.consumed()).toBe(0);
    expect(ledger.sent).toHaveLength(0);
  });

  it('approved by a different person, one linked reversal posts under the stored key, and the original is reversed once', async () => {
    const { desk, ledger, ids, store } = setup();
    await desk.request(FOUNDER, ask);
    const approval = ids.propose('1', ask.reason, ask.caseRef);
    const posted = await desk.execute(FOUNDER, { requestNo: '1', ...approval });
    expect(posted).toMatchObject({ state: 'posted', reversingTxId: REVERSING, approverId: APPROVER, attempts: 1, code: null });
    expect(ledger.sent).toEqual([
      { call: { originalTxId: ORIGINAL, ordinal: '1', reason: ask.reason, caseRef: ask.caseRef }, key: `ops:reversal:${ORIGINAL}:1` },
    ]);
    // The same run again answers from the row: no second consume, no second send.
    expect(await desk.execute(FOUNDER, { requestNo: '1', ...approval })).toMatchObject({ state: 'posted', reversingTxId: REVERSING });
    expect(ids.consumed()).toBe(1);
    expect(ledger.sent).toHaveLength(1);
    // Reversing it again is refused by name with the first reversal, and nothing is written.
    const again = await refusal(desk.request(FOUNDER, { ...ask, caseRef: 'CASE-8' }));
    expect(again.code).toBe('ops.reversal_already_reversed');
    expect(again.message).toContain(REVERSING);
    expect(store.all()).toHaveLength(1);
    // A different approval on a request that already ran is refused.
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '1', approvalId: 'ap_9', operationId: 'op_9' }))).code).toBe(
      'ops.reversal_state_illegal',
    );
  });

  it('a lost reply leaves pending_retry; asking again sends the same key and body, and exactly one booking exists', async () => {
    const { desk, ledger, ids } = setup();
    await desk.request(FOUNDER, ask);
    const approval = ids.propose('1', ask.reason, ask.caseRef);
    ledger.next('lost');
    expect(await desk.execute(FOUNDER, { requestNo: '1', ...approval })).toMatchObject({
      state: 'pending_retry',
      code: 'ledger.reply_lost',
      reversingTxId: null,
    });
    const retried = await desk.execute(FOUNDER, { requestNo: '1', ...approval });
    expect(retried).toMatchObject({ state: 'posted', reversingTxId: REVERSING, ordinal: '1', attempts: 2 });
    expect(ledger.sent).toHaveLength(2);
    expect(ledger.sent[1]).toEqual(ledger.sent[0]);
    expect(ledger.bookings()).toBe(1);
    expect(ids.consumed()).toBe(1);
  });

  it('the posting freeze leaves pending_retry with no new key; the worker sends the same request once it is due', async () => {
    const { desk, ledger, ids, tick } = setup();
    await desk.request(FOUNDER, ask);
    const approval = ids.propose('1', ask.reason, ask.caseRef);
    ledger.next('frozen');
    expect(await desk.execute(FOUNDER, { requestNo: '1', ...approval })).toMatchObject({ state: 'pending_retry', code: 'ledger.frozen' });
    expect(await desk.resolve()).toBe(0);
    tick(30_000);
    expect(await desk.resolve()).toBe(1);
    expect(await desk.get('1')).toMatchObject({ state: 'posted', reversingTxId: REVERSING, ledgerKey: `ops:reversal:${ORIGINAL}:1` });
    expect(new Set(ledger.sent.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it('a ledger refusal is stored on the row; a new request takes the next ordinal and a new key', async () => {
    const { desk, ledger, ids } = setup();
    await desk.request(FOUNDER, ask);
    ledger.next('insufficient');
    const refused = await desk.execute(FOUNDER, { requestNo: '1', ...ids.propose('1', ask.reason, ask.caseRef) });
    expect(refused).toMatchObject({ state: 'refused', code: 'ledger.insufficient_funds', reversingTxId: null });
    expect(await desk.resolve()).toBe(0);
    const next = await desk.request(FOUNDER, ask);
    expect(next).toMatchObject({ requestNo: '2', ordinal: '2', ledgerKey: `ops:reversal:${ORIGINAL}:2`, state: 'intent' });
    const posted = await desk.execute(FOUNDER, { requestNo: '2', ...ids.propose('2', ask.reason, ask.caseRef) });
    expect(posted).toMatchObject({ state: 'posted', reversingTxId: REVERSING });
  });

  it('a reversal the ledger names as already there is stored, and the next request is refused with it', async () => {
    const { desk, ledger, ids } = setup();
    const theirs = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    ledger.seed(ORIGINAL, `ops:reversal:${ORIGINAL}:99`, theirs);
    await desk.request(FOUNDER, ask);
    const refused = await desk.execute(FOUNDER, { requestNo: '1', ...ids.propose('1', ask.reason, ask.caseRef) });
    expect(refused).toMatchObject({ state: 'refused', code: 'ledger.reversal_already_reversed', reversedBy: theirs });
    const again = await refusal(desk.request(FOUNDER, ask));
    expect(again.code).toBe('ops.reversal_already_reversed');
    expect(again.message).toContain(theirs);
  });

  it('a second open request for a reversed original is refused before its approval is spent', async () => {
    const { desk, ids, ledger } = setup();
    await desk.request(FOUNDER, ask);
    await desk.request(FOUNDER, { ...ask, caseRef: 'CASE-9' });
    await desk.execute(FOUNDER, { requestNo: '1', ...ids.propose('1', ask.reason, ask.caseRef) });
    const second = ids.propose('2', ask.reason, 'CASE-9');
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '2', ...second }))).code).toBe('ops.reversal_already_reversed');
    expect(ids.consumed()).toBe(1);
    expect(ledger.sent).toHaveLength(1);
    expect((await desk.get('2')).state).toBe('intent');
  });

  it('without the ledger or storage every action refuses by name before anything is written', async () => {
    const noLedger = setup({ ledger: false });
    expect((await refusal(noLedger.desk.request(FOUNDER, ask))).code).toBe('ops.reversal_ledger_unconfigured');
    expect(noLedger.store.all()).toHaveLength(0);
    expect((await refusal(noLedger.desk.execute(FOUNDER, { requestNo: '1', approvalId: 'a', operationId: 'o' }))).code).toBe(
      'ops.reversal_ledger_unconfigured',
    );
    const noStore = setup({ store: false });
    expect((await refusal(noStore.desk.request(FOUNDER, ask))).code).toBe('ops.reversal_storage_unconfigured');
    expect((await refusal(noStore.desk.list(ORIGINAL, 10))).code).toBe('ops.reversal_storage_unconfigured');
    expect(noStore.ledger.sent).toHaveLength(0);
  });

  it('an unknown request number is ops.reversal_not_found', async () => {
    const { desk } = setup();
    expect((await refusal(desk.get('7'))).code).toBe('ops.reversal_not_found');
    expect((await refusal(desk.execute(FOUNDER, { requestNo: '7', approvalId: 'a', operationId: 'o' }))).code).toBe(
      'ops.reversal_not_found',
    );
  });

  it('lists an original’s requests newest first', async () => {
    const { desk, ids, ledger } = setup();
    await desk.request(FOUNDER, ask);
    ledger.next('insufficient');
    await desk.execute(FOUNDER, { requestNo: '1', ...ids.propose('1', ask.reason, ask.caseRef) });
    await desk.request(FOUNDER, ask);
    const list = await desk.list(ORIGINAL.toUpperCase(), 10);
    expect(list.reversals.map((r) => [r.requestNo, r.state])).toEqual([
      ['2', 'intent'],
      ['1', 'refused'],
    ]);
  });
});

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signedAs(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
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

describe('ledgerReversals on the ops router', () => {
  it('asks and runs on admin:treasury as the caller, reads on admin:read, and refuses by name over the wire', async () => {
    const { desk, ids, ledger } = setup();
    const router = createOpsRouter(new OpsService(), undefined, { ledgerReversals: desk });
    const treasury = router.createCaller(await signedAs(FOUNDER, ['admin:read', 'admin:treasury']));
    const reader = router.createCaller(await signedAs(FOUNDER, ['admin:read']));
    await expect(reader.ledgerReversals.request(ask)).rejects.toThrow(/admin:treasury|FORBIDDEN|scope/i);
    const intent = await treasury.ledgerReversals.request(ask);
    expect(intent).toMatchObject({ requestNo: '1', state: 'intent', requestedBy: FOUNDER });
    expect(await reader.ledgerReversals.get({ requestNo: '1' })).toMatchObject({ state: 'intent' });
    const posted = await treasury.ledgerReversals.execute({ requestNo: '1', ...ids.propose('1', ask.reason, ask.caseRef) });
    expect(posted).toMatchObject({ state: 'posted', reversingTxId: REVERSING });
    await expect(treasury.ledgerReversals.request(ask)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('ops.reversal_already_reversed'),
    });
    const list = await reader.ledgerReversals.list({ originalTxId: ORIGINAL, limit: 5 });
    expect(list.reversals).toHaveLength(1);
    expect(ledger.sent).toHaveLength(1);
    await expect(reader.ledgerReversals.get({ requestNo: '9' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('with no desk wired, every call refuses ops.reversal_storage_unconfigured', async () => {
    const router = createOpsRouter(new OpsService(), undefined, {});
    const treasury = router.createCaller(await signedAs(FOUNDER, ['admin:read', 'admin:treasury']));
    await expect(treasury.ledgerReversals.request(ask)).rejects.toThrow(/ops\.reversal_storage_unconfigured/);
    await expect(treasury.ledgerReversals.list({ originalTxId: ORIGINAL, limit: 5 })).rejects.toThrow(/ops\.reversal_storage_unconfigured/);
  });
});
