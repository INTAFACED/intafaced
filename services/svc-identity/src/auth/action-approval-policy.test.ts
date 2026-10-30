/**
 * OPS-change-control-01 CR-1: per-action-type approval policy. Every refusal branch, the multi-approver count, and the
 * invariant that a governed approval is consumable iff it holds at least N distinct non-requester approvals from the
 * policy audience under the policy version it was proposed under.
 */
import { describe, expect, it } from 'vitest';
import { POLICY_GOVERNED_ACTION_TYPES, type ActionApprovalProposeInput } from '@intafaced/contracts';
import { staticFounderDirectory } from './action-approval-audience.js';
import { approvalPolicyEntries, approvalPolicySource, policyVersionOf, readApprovalPolicies } from './action-approval-policy.js';
import { ActionApprovalService } from './action-approval-service.js';
import { MemoryActionApprovalStore } from './action-approval-store.js';

const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-10-30T10:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  requiredApprovals: '2',
  approverAudience: 'operator',
  applier: 'svc-ops',
  maxAgeSeconds: '300',
  ...over,
});
const setting = (rows: Record<string, unknown>) => JSON.stringify(rows);

const reverse: ActionApprovalProposeInput = {
  actionType: 'ops.ledger.reverse',
  targetService: 'svc-ops',
  targetId: 'reverse:tx-1',
  expectedVersion: '1',
  payloadHash: 'sha256:rev',
  policyVersion: 'desk-v1',
};

function rig(raw: { value: string | undefined }, opts: { ttl?: number; founders?: string[] } = {}) {
  const store = new MemoryActionApprovalStore();
  let now = NOW;
  const svc = new ActionApprovalService(
    store,
    {
      ttlSeconds: opts.ttl ?? 600,
      founders: staticFounderDirectory(opts.founders ?? []),
      policies: approvalPolicySource(() => raw.value),
    },
    () => now,
  );
  return { svc, store, advance: (seconds: number) => (now = new Date(now.getTime() + seconds * 1000)) };
}

const consumeOf = (a: { approvalId: string; operationId: string; payloadHash: string; targetId: string; expectedVersion: string }) => ({
  approvalId: a.approvalId,
  operationId: a.operationId,
  payloadHash: a.payloadHash,
  targetService: 'svc-ops',
  targetId: a.targetId,
  expectedVersion: a.expectedVersion,
});

describe('readApprovalPolicies', () => {
  it('reads a whole row, from JSON integers or digit strings, and versions it by its values', () => {
    const a = readApprovalPolicies(setting({ 'ops.ledger.reverse': row() }))['ops.ledger.reverse'];
    const b = readApprovalPolicies(setting({ 'ops.ledger.reverse': row({ requiredApprovals: 2, maxAgeSeconds: 300 }) }))[
      'ops.ledger.reverse'
    ];
    expect(a).toEqual({
      state: 'set',
      policy: {
        requiredApprovals: 2,
        approverAudience: 'operator',
        applier: 'svc-ops',
        maxAgeSeconds: 300,
        version: policyVersionOf('ops.ledger.reverse', {
          requiredApprovals: 2,
          approverAudience: 'operator',
          applier: 'svc-ops',
          maxAgeSeconds: 300,
        }),
      },
    });
    expect(b).toEqual(a);
    const other = readApprovalPolicies(setting({ 'ops.ledger.reverse': row({ requiredApprovals: '3' }) }))['ops.ledger.reverse'];
    expect(other.state === 'set' && a.state === 'set' && other.policy.version !== a.policy.version).toBe(true);
    // The type is part of the version: the same values on another type do not share it.
    const adjust = readApprovalPolicies(setting({ 'ops.ledger.adjust': row() }))['ops.ledger.adjust'];
    expect(adjust.state === 'set' && a.state === 'set' && adjust.policy.version !== a.policy.version).toBe(true);
  });

  it.each([
    ['unset setting', undefined],
    ['blank setting', '   '],
    ['not JSON', '{"ops.ledger.reverse":'],
    ['an array', '[]'],
    ['row missing', setting({ 'ops.ledger.adjust': row() })],
    ['row blank', setting({ 'ops.ledger.reverse': '' })],
    ['row null', setting({ 'ops.ledger.reverse': null })],
    ['count blank', setting({ 'ops.ledger.reverse': row({ requiredApprovals: '' }) })],
    ['count zero', setting({ 'ops.ledger.reverse': row({ requiredApprovals: '0' }) })],
    ['count zero number', setting({ 'ops.ledger.reverse': row({ requiredApprovals: 0 }) })],
    ['count negative', setting({ 'ops.ledger.reverse': row({ requiredApprovals: -1 }) })],
    ['count fractional', setting({ 'ops.ledger.reverse': row({ requiredApprovals: 1.5 }) })],
    ['count fractional string', setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1.5' }) })],
    ['count words', setting({ 'ops.ledger.reverse': row({ requiredApprovals: 'two' }) })],
    ['count missing', setting({ 'ops.ledger.reverse': { approverAudience: 'operator', applier: 'svc-ops', maxAgeSeconds: '300' } })],
    ['age zero', setting({ 'ops.ledger.reverse': row({ maxAgeSeconds: '0' }) })],
    ['age missing', setting({ 'ops.ledger.reverse': row({ maxAgeSeconds: undefined }) })],
    ['audience unknown', setting({ 'ops.ledger.reverse': row({ approverAudience: 'anyone' }) })],
    ['audience self', setting({ 'ops.ledger.reverse': row({ approverAudience: 'self' }) })],
    ['applier blank', setting({ 'ops.ledger.reverse': row({ applier: '' }) })],
    ['applier not a service', setting({ 'ops.ledger.reverse': row({ applier: 'ops' }) })],
    ['unknown key', setting({ 'ops.ledger.reverse': row({ requiredApprovalz: '3' }) })],
    ['two spellings of one type', setting({ 'ops.ledger.reverse': row(), 'OPS.LEDGER.REVERSE': row({ requiredApprovals: '1' }) })],
  ])('%s is unset', (_name, raw) => {
    expect(readApprovalPolicies(raw)['ops.ledger.reverse']).toEqual({ state: 'unset' });
  });

  it('a bad row unsets only its own type', () => {
    const read = readApprovalPolicies(setting({ 'ops.ledger.reverse': row({ requiredApprovals: '0' }), 'ops.ledger.adjust': row() }));
    expect(read['ops.ledger.reverse'].state).toBe('unset');
    expect(read['ops.ledger.adjust'].state).toBe('set');
  });

  it('a founder row that needs more than one other founder can never be met, so it is no row', () => {
    const read = readApprovalPolicies(
      setting({
        'ops.ledger.reverse': row({ approverAudience: 'founder', requiredApprovals: '2' }),
        'ops.ledger.adjust': row({ approverAudience: 'founder', requiredApprovals: '1' }),
      }),
    );
    expect(read['ops.ledger.reverse'].state).toBe('unset');
    expect(read['ops.ledger.adjust'].state).toBe('set');
  });

  it('reads the setting again only when it changes', () => {
    const raw = { value: setting({ 'ops.ledger.reverse': row() }) as string | undefined };
    let reads = 0;
    const source = approvalPolicySource(() => {
      reads += 1;
      return raw.value;
    });
    const first = source('ops.ledger.reverse');
    expect(source('ops.ledger.reverse')).toBe(first);
    raw.value = '';
    expect(source('ops.ledger.reverse').state).toBe('unset');
    expect(reads).toBe(3);
  });

  it('lists every governed type, set or unset with the typed code, and never throws', () => {
    const entries = approvalPolicyEntries(approvalPolicySource(() => setting({ 'ops.ledger.adjust': row() })));
    expect(entries.map((e) => e.actionType)).toEqual([...POLICY_GOVERNED_ACTION_TYPES]);
    expect(entries[0]).toEqual({ state: 'unset', actionType: 'ops.ledger.reverse', code: 'action_approval.policy_unset' });
    expect(entries[1]?.state).toBe('set');
    expect(
      approvalPolicyEntries(() => {
        throw new Error('boom');
      }).every((e) => e.state === 'unset'),
    ).toBe(true);
    expect(approvalPolicyEntries(undefined).every((e) => e.state === 'unset')).toBe(true);
  });
});

describe('governed propose', () => {
  it('refuses policy_unset for a blank, zero or unreadable row and writes nothing', async () => {
    for (const value of [undefined, '', 'nope', setting({ 'ops.ledger.reverse': row({ requiredApprovals: '0' }) })]) {
      const { svc, store } = rig({ value });
      await expect(svc.propose(REQ, reverse)).rejects.toMatchObject({ code: 'action_approval.policy_unset' });
      expect(await store.listByRequester(REQ, 10)).toEqual([]);
    }
  });

  it('a different spelling of a governed type is still governed', async () => {
    const { svc } = rig({ value: undefined });
    await expect(svc.propose(REQ, { ...reverse, actionType: ' OPS.Ledger.Reverse ' })).rejects.toMatchObject({
      code: 'action_approval.policy_unset',
    });
  });

  it('refuses a target service other than the policy applier', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    await expect(svc.propose(REQ, { ...reverse, targetService: 'svc-ledger' })).rejects.toMatchObject({
      code: 'action_approval.service_mismatch',
    });
    expect(await store.listByRequester(REQ, 10)).toEqual([]);
  });

  it('still refuses ttl_unset when the shared lifetime is blank', async () => {
    const store = new MemoryActionApprovalStore();
    const svc = new ActionApprovalService(store, {
      ttlSeconds: undefined,
      policies: approvalPolicySource(() => setting({ 'ops.ledger.reverse': row() })),
    });
    await expect(svc.propose(REQ, reverse)).rejects.toMatchObject({ code: 'action_approval.ttl_unset' });
  });

  it('caps the lifetime at the policy maximum age and never lengthens it', async () => {
    const short = await rig({ value: setting({ 'ops.ledger.reverse': row({ maxAgeSeconds: '120' }) }) }).svc.propose(REQ, reverse);
    expect(new Date(short.expiresAt).getTime() - NOW.getTime()).toBe(120_000);
    const long = await rig({ value: setting({ 'ops.ledger.reverse': row({ maxAgeSeconds: '9000' }) }) }).svc.propose(REQ, reverse);
    expect(new Date(long.expiresAt).getTime() - NOW.getTime()).toBe(600_000);
  });

  it('binds the request to the required count and the policy version', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '3' }) }) });
    const p = await svc.propose(REQ, reverse);
    expect(p).toMatchObject({ status: 'PENDING', approvalsRequired: 3, approvalsGiven: 0, policyVersion: 'desk-v1' });
    const stored = await store.get(p.approvalId);
    expect(stored?.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('governed approve and consume', () => {
  it('policy of two approvals, one given, applied -> refused; the second makes it consumable once', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    const one = await svc.approve(B, p.approvalId, p.payloadHash);
    expect(one).toMatchObject({ status: 'PENDING', approvalsGiven: 1, approvalsRequired: 2, approverId: null });
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.not_approved' });
    const two = await svc.approve(C, p.approvalId, p.payloadHash);
    expect(two).toMatchObject({ status: 'APPROVED', approvalsGiven: 2, approverId: C });
    const consumed = await svc.consume('svc-ops', consumeOf(p));
    expect(consumed.status).toBe('CONSUMED');
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.consumed' });
  });

  it('a founder-namespaced request is founders-only even when its row names operators', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    expect(svc.audienceFor({ actionType: 'ops.ledger.reverse', targetService: 'svc-ops', targetId: 'reverse:tx-1' })).toBe('operator');
    expect(svc.audienceFor({ actionType: 'ops.ledger.reverse', targetService: 'svc-ops', targetId: 'treasury.sweep:tx-1' })).toBe(
      'founder',
    );
    // Still refuses with the row unset: founders never stand in for a missing policy.
    const blank = rig({ value: undefined }).svc;
    expect(() =>
      blank.audienceFor({ actionType: 'ops.ledger.reverse', targetService: 'svc-ops', targetId: 'treasury.sweep:tx-1' }),
    ).toThrow(expect.objectContaining({ code: 'action_approval.policy_unset' }));
  });

  it('a voter no longer sees the row in their pending list while it waits on others', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    const access = { operator: true, founder: false };
    expect((await svc.listForCaller(B, 'pending', 10, access)).approvals.map((a) => a.approvalId)).toEqual([p.approvalId]);
    await svc.approve(B, p.approvalId, p.payloadHash);
    expect((await svc.listForCaller(B, 'pending', 10, access)).approvals).toEqual([]);
    expect((await svc.listForCaller(C, 'pending', 10, access)).approvals.map((a) => a.approvalId)).toEqual([p.approvalId]);
  });

  it('the requester cannot reject their own request in any letter case', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    await expect(svc.reject(REQ.toUpperCase(), p.approvalId)).rejects.toMatchObject({ code: 'action_approval.same_person' });
  });

  it('a third approval after the count is reached is not_pending', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    await svc.approve(B, p.approvalId, p.payloadHash);
    await svc.approve(C, p.approvalId, p.payloadHash);
    await expect(svc.approve(D, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.not_pending' });
  });

  it('the author approving is same_person; the same approver twice is already_approved and counts once', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    await expect(svc.approve(REQ, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.same_person' });
    await expect(svc.approve(REQ.toUpperCase(), p.approvalId, p.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.same_person',
    });
    await svc.approve(B, p.approvalId, p.payloadHash);
    await expect(svc.approve(B, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.already_approved' });
    await expect(svc.approve(B.toUpperCase(), p.approvalId, p.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.already_approved',
    });
    expect((await store.get(p.approvalId))?.status).toBe('PENDING');
    expect(await store.listVotes(p.approvalId)).toHaveLength(1);
  });

  it('a payload the approver did not review is refused and not counted', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    await expect(svc.approve(B, p.approvalId, 'sha256:other')).rejects.toMatchObject({ code: 'action_approval.payload_mismatch' });
    expect(await store.listVotes(p.approvalId)).toHaveLength(0);
  });

  it('a payload changed after approval is invalid at consume', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) }) });
    const p = await svc.propose(REQ, reverse);
    await svc.approve(B, p.approvalId, p.payloadHash);
    await expect(svc.consume('svc-ops', { ...consumeOf(p), payloadHash: 'sha256:changed' })).rejects.toMatchObject({
      code: 'action_approval.payload_mismatch',
    });
  });

  it('a consumer other than the policy applier is service_mismatch', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) }) });
    const p = await svc.propose(REQ, reverse);
    await svc.approve(B, p.approvalId, p.payloadHash);
    await expect(svc.consume('svc-ledger', { ...consumeOf(p), targetService: 'svc-ledger' })).rejects.toMatchObject({
      code: 'action_approval.service_mismatch',
    });
  });

  it('a policy blanked after propose refuses approve and consume with policy_unset', async () => {
    const raw = { value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) }) as string | undefined };
    const { svc } = rig(raw);
    const p = await svc.propose(REQ, reverse);
    raw.value = '';
    await expect(svc.approve(B, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.policy_unset' });
    raw.value = setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) });
    await svc.approve(B, p.approvalId, p.payloadHash);
    raw.value = setting({ 'ops.ledger.reverse': row({ requiredApprovals: 'x' }) });
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.policy_unset' });
  });

  it('a policy changed after propose refuses approve and consume with policy_changed, in either direction', async () => {
    const raw = { value: setting({ 'ops.ledger.reverse': row() }) as string | undefined };
    const { svc } = rig(raw);
    const p = await svc.propose(REQ, reverse);
    await svc.approve(B, p.approvalId, p.payloadHash);
    // Weaker rule after propose: the one approval is NOT now enough.
    raw.value = setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) });
    await expect(svc.approve(C, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.policy_changed' });
    raw.value = setting({ 'ops.ledger.reverse': row() });
    await svc.approve(C, p.approvalId, p.payloadHash);
    // Any change of value, not only the count: a different applier or age.
    for (const changed of [row({ maxAgeSeconds: '301' }), row({ approverAudience: 'founder', requiredApprovals: '1' })]) {
      raw.value = setting({ 'ops.ledger.reverse': changed });
      await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.policy_changed' });
    }
    raw.value = setting({ 'ops.ledger.reverse': row() });
    expect((await svc.consume('svc-ops', consumeOf(p))).status).toBe('CONSUMED');
  });

  it('a request filed under a governed type with no bound policy is never applied', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1' }) }) });
    // As if filed before the type was governed: no count, no policy hash, approved by the fixed rule.
    await store.insert({
      approvalId: 'legacy',
      actionType: 'ops.ledger.reverse',
      targetService: 'svc-ops',
      targetId: 'reverse:tx-1',
      expectedVersion: '1',
      payloadHash: 'sha256:rev',
      requesterId: REQ,
      approverId: B,
      policyVersion: 'v0',
      operationId: 'op-legacy',
      status: 'APPROVED',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      approvedAt: NOW,
      consumedAt: null,
    });
    await expect(
      svc.consume('svc-ops', { ...consumeOf({ ...reverse, approvalId: 'legacy', operationId: 'op-legacy' }) }),
    ).rejects.toMatchObject({ code: 'action_approval.policy_changed' });
  });

  it('a request bound to a policy whose type is no longer governed is policy_changed, never policy_unset', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    await store.insert({
      approvalId: 'ungoverned',
      actionType: 'ops.ledger.retired',
      targetService: 'svc-ops',
      targetId: 'reverse:tx-1',
      expectedVersion: '1',
      payloadHash: 'sha256:rev',
      requesterId: REQ,
      approverId: null,
      policyVersion: 'v0',
      operationId: 'op-ungoverned',
      status: 'PENDING',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      approvedAt: null,
      consumedAt: null,
      approvalsRequired: 2,
      policyHash: 'sha256:' + '0'.repeat(64),
    });
    await expect(svc.approve(B, 'ungoverned', 'sha256:rev')).rejects.toMatchObject({ code: 'action_approval.policy_changed' });
  });

  it('an expired governed request is expired, at approve and at consume', async () => {
    const { svc, advance } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: '1', maxAgeSeconds: '60' }) }) });
    const p = await svc.propose(REQ, reverse);
    advance(61);
    await expect(svc.approve(B, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.expired' });
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.expired' });
  });

  it('founder audience: every approver and the requester must be live founders, at approve and again at consume', async () => {
    const founders = new Set([REQ, B, C]);
    const store = new MemoryActionApprovalStore();
    const svc = new ActionApprovalService(
      store,
      {
        ttlSeconds: 600,
        founders: { isFounder: async (id) => founders.has(id) },
        policies: approvalPolicySource(() =>
          setting({ 'ops.ledger.adjust': row({ approverAudience: 'founder', requiredApprovals: '1' }) }),
        ),
      },
      () => NOW,
    );
    const p = await svc.propose(REQ, { ...reverse, actionType: 'ops.ledger.adjust' });
    await expect(svc.approve(D, p.approvalId, p.payloadHash)).rejects.toMatchObject({ code: 'action_approval.founder_only' });
    // Production's founders are a fixed pair, so a founder row needs one other founder.
    await svc.approve(B, p.approvalId, p.payloadHash);
    founders.delete(B);
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
    founders.add(B);
    const consumed = await svc.consume('svc-ops', consumeOf(p));
    expect(consumed).toMatchObject({ status: 'CONSUMED', approverIsFounder: true, requesterIsFounder: true });
  });

  it('a governed row never turns APPROVED through the fixed one-approver CAS', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    expect(await store.casApprove(p.approvalId, B, NOW)).toBeNull();
    expect((await store.get(p.approvalId))?.status).toBe('PENDING');
  });

  it('the consume CAS refuses a governed row whose votes fall short, even if marked APPROVED', async () => {
    const { svc, store } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    const stored = (await store.get(p.approvalId))!;
    // Simulate a row forced to APPROVED with no votes behind it.
    await store.insert({ ...stored, approvalId: 'forced', operationId: 'op-forced', status: 'APPROVED', approverId: B, approvedAt: NOW });
    await expect(svc.consume('svc-ops', consumeOf({ ...p, approvalId: 'forced', operationId: 'op-forced' }))).rejects.toMatchObject({
      code: 'action_approval.not_approved',
    });
    expect(await store.casConsume({ ...consumeOf({ ...p, approvalId: 'forced', operationId: 'op-forced' }), now: NOW })).toBeNull();
  });

  it('a reject by someone else still turns a governed request down', async () => {
    const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row() }) });
    const p = await svc.propose(REQ, reverse);
    await svc.approve(B, p.approvalId, p.payloadHash);
    expect((await svc.reject(C, p.approvalId)).status).toBe('REJECTED');
    await expect(svc.consume('svc-ops', consumeOf(p))).rejects.toMatchObject({ code: 'action_approval.already_terminal' });
  });
});

describe('invariant: consumable iff >= N distinct non-requester approvals under the bound policy', () => {
  it('holds for every count from 1 to 4 and every number of approvals given', async () => {
    const approvers = [B, C, D, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'];
    for (let n = 1; n <= 4; n += 1) {
      for (let given = 0; given <= n; given += 1) {
        const { svc } = rig({ value: setting({ 'ops.ledger.reverse': row({ requiredApprovals: String(n) }) }) });
        const p = await svc.propose(REQ, reverse);
        // The requester and a repeat approver never count.
        await svc.approve(REQ, p.approvalId, p.payloadHash).catch(() => undefined);
        for (const who of approvers.slice(0, given)) {
          await svc.approve(who, p.approvalId, p.payloadHash);
          await svc.approve(who, p.approvalId, p.payloadHash).catch(() => undefined);
        }
        const outcome = await svc.consume('svc-ops', consumeOf(p)).then(
          (r) => r.status,
          (e: { code: string }) => e.code,
        );
        expect(outcome, `n=${n} given=${given}`).toBe(given >= n ? 'CONSUMED' : 'action_approval.not_approved');
      }
    }
  });
});

describe('ungoverned types keep the fixed rule', () => {
  it('one distinct approver makes the row consumable whatever the policy setting holds', async () => {
    for (const value of [undefined, setting({ 'kyc.override': row({ requiredApprovals: '5' }) })]) {
      const store = new MemoryActionApprovalStore();
      const svc = new ActionApprovalService(store, { ttlSeconds: 60, policies: approvalPolicySource(() => value) }, () => NOW);
      const p = await svc.propose(REQ, { ...reverse, actionType: 'kyc.override', targetService: 'svc-identity', targetId: 'user-1' });
      expect(p.approvalsRequired).toBeUndefined();
      expect((await svc.approve(B, p.approvalId, p.payloadHash)).status).toBe('APPROVED');
      const consumed = await svc.consume('svc-identity', { ...consumeOf(p), targetService: 'svc-identity' });
      expect(consumed.status).toBe('CONSUMED');
      expect(await store.listVotes(p.approvalId)).toEqual([]);
    }
  });
});
