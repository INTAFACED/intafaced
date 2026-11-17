import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createMemoryQuota } from '../quota/memory.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryTeamRepository } from '../team/memory-repository.js';
import { createMemoryApprovalRepository } from './repository.js';

// RC-algo-dev-01 (J-algo-dev-16 #4): the account's live approval policy, an independent review bound to a content hash,
// and the live read svc-trade's runner gates a start on.
const SECRET = 'a-quant-approval-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') },
    id: `req-${userId}`,
  });
}

function setup() {
  const quota = createMemoryQuota({ defaultProfile: null });
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
    team: createMemoryTeamRepository(),
    quota: quota.repository,
    approvals: createMemoryApprovalRepository(),
    editLockSeconds: 30,
    releaseNoteMax: 500,
  });
  return { owner: app.createCaller(signed(OWNER)), mate: app.createCaller(signed(MATE)), other: app.createCaller(signed(OTHER)) };
}

const block = (qty: string) => ({
  name: 'TEST reviewed',
  blocks: [{ side: 'buy' as const, symbol: 'BTC/USDT', qty }],
  risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
  cash: '1000',
  environment: 'paper' as const,
  clientStrategyId: 'client-reviewed',
});

describe('live approval policy (RC-algo-dev-01)', () => {
  it('reads not set and asks nothing of a live start until the owner sets it', async () => {
    const t = setup();
    const s = await t.owner.studio.save({ ...block('0.001'), idempotencyKey: 'save-1' });
    expect(await t.owner.approval.policy.get()).toEqual({ required: null, setAt: null });
    expect((await t.owner.studio.get({ id: s.id })).liveApproval).toEqual({ required: false, approvedVersions: [] });
    await expect(t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 })).rejects.toThrow(/^quant\.approval_policy_unset — /);
  });

  it('a different member approves; the owner cannot; any change voids it; the same decision twice is one row', async () => {
    const t = setup();
    const s = await t.owner.studio.save({ ...block('0.001'), idempotencyKey: 'save-1' });
    await t.owner.approval.policy.set({ required: true, idempotencyKey: 'p1' });
    let state = await t.owner.approval.get({ strategyId: s.id });
    expect(state.live).toEqual({ allowed: false, code: 'quant.approval_required' });
    expect((await t.owner.studio.get({ id: s.id })).liveApproval).toEqual({ required: true, approvedVersions: [] });

    state = await t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 });
    expect(state.approvals).toHaveLength(1);
    // The same ask again is the same request.
    expect((await t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 })).approvals).toHaveLength(1);
    const id = state.approvals[0]!.approvalId;

    await expect(t.owner.approval.decide({ strategyId: s.id, approvalId: id, decision: 'approved', reason: '' })).rejects.toThrow(
      /^quant\.approval_self_review — /,
    );
    // Not shared: not found, the same as a missing strategy.
    await expect(t.other.approval.decide({ strategyId: s.id, approvalId: id, decision: 'approved', reason: '' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'view', liveControl: false });
    expect((await t.mate.approval.get({ strategyId: s.id })).canDecide).toBe(true);
    state = await t.mate.approval.decide({ strategyId: s.id, approvalId: id, decision: 'approved', reason: 'TEST looks right' });
    expect(state.approvals[0]).toMatchObject({ decision: 'approved', reviewer: MATE, current: true });
    expect(state.live).toEqual({ allowed: true, code: null });
    // The same decision again reads back the one row; another decision is refused.
    expect(
      (await t.mate.approval.decide({ strategyId: s.id, approvalId: id, decision: 'approved', reason: 'TEST looks right' })).approvals,
    ).toHaveLength(1);
    await expect(t.mate.approval.decide({ strategyId: s.id, approvalId: id, decision: 'rejected', reason: '' })).rejects.toThrow(
      /^quant\.approval_decided — /,
    );
    expect((await t.owner.studio.get({ id: s.id })).liveApproval).toEqual({ required: true, approvedVersions: [1] });

    // A changed parameter is version 2, with no approval.
    await t.owner.studio.update({ id: s.id, ...block('0.002'), idempotencyKey: 'save-2' });
    state = await t.owner.approval.get({ strategyId: s.id });
    expect(state.version).toBe(2);
    expect(state.live).toEqual({ allowed: false, code: 'quant.approval_required' });
    expect((await t.owner.studio.get({ id: s.id })).liveApproval).toEqual({ required: true, approvedVersions: [1] });
  });

  it('a request whose risk settings changed since is stale and voids the approval', async () => {
    const t = setup();
    const s = await t.owner.studio.save({ ...block('0.001'), idempotencyKey: 'save-1' });
    await t.owner.approval.policy.set({ required: true, idempotencyKey: 'p1' });
    await t.owner.team.set({ strategyId: s.id, memberId: MATE, role: 'view', liveControl: false });
    const id = (await t.owner.approval.request({ strategyId: s.id, strategyVersion: 1 })).approvals[0]!.approvalId;
    await t.owner.risk.set({
      strategyId: s.id,
      caps: { depositPercent: '', maxPositionNotional: '500', maxDailyLoss: '', equityFloor: '900' },
      floorPolicy: 'reduce_only',
    });
    await expect(t.mate.approval.decide({ strategyId: s.id, approvalId: id, decision: 'approved', reason: '' })).rejects.toThrow(
      /^quant\.approval_hash_stale — /,
    );
  });
});
