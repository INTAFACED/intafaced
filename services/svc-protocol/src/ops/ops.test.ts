/**
 * Protocol ops desk (D-order-controls-04): four-eyes listing control, the label audit and the metrics read.
 *
 * Promise: a hide, delist or restore changes the listing only after a distinct second founder's approval is consumed once;
 * a retry with the same approval returns the stored result; a second approval of the same move is a no-op; a crash between
 * the consume and the write leaves nothing hidden and the replay finishes it once. A source that fails reads "could not
 * load", never zero. A blank reason-code list or metrics window refuses `owner.decision`.
 * Break: one person approves their own hide; a typed name stands in for the approval; a hide applies with no approval;
 * a retry hides twice or logs twice; a failed source shows 0; a reason code is invented.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type NetworkEntry,
} from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { ActionApprovalConsumeError, opsPayloadHash, unwiredApprovalConsumer, type ActionApprovalConsumer } from './approvals.js';
import { OpsRefusal, ProtocolOpsDesk } from './desk.js';
import { serviceLabelEntries } from './labels.js';
import { InMemoryListingStore, type ListingStore } from './listing.js';
import { buildMetrics, OPS_SOURCE_UNAVAILABLE } from './metrics.js';

const POOL = '0x' + 'ab'.repeat(20);
const CHAIN = 84532;
const POOL_TARGET = `${CHAIN}:${POOL}`;
const REASONS = ['scam_report', 'legal_request'];

type Proposal = {
  actionType: string;
  targetId: string;
  payloadHash: string;
  expectedVersion: string;
  requesterId: string;
  approverId: string;
};

/** An identity stand-in: one stored row per approval, consumed once per request, bound to the payload it was signed over. */
function identity(proposals: Record<string, Proposal & { founders?: boolean }>) {
  const consumedBy = new Map<string, string>();
  const calls: ActionApprovalConsumeInput[] = [];
  const consumer: ActionApprovalConsumer = {
    async consume(input) {
      calls.push(input);
      const row = proposals[input.approvalId];
      if (!row) throw new ActionApprovalConsumeError('identity refused consume (404)', 'action_approval.consume_failed');
      if (row.payloadHash !== input.payloadHash || row.targetId !== input.targetId || row.expectedVersion !== input.expectedVersion) {
        throw new ActionApprovalConsumeError('identity refused consume (409) payload mismatch', 'action_approval.consume_failed');
      }
      const owner = consumedBy.get(input.approvalId);
      if (owner && owner !== input.operationId)
        throw new ActionApprovalConsumeError('identity refused consume (409) consumed', 'action_approval.consume_failed');
      consumedBy.set(input.approvalId, input.operationId);
      return {
        approvalId: input.approvalId,
        actionType: row.actionType,
        targetService: input.targetService,
        targetId: row.targetId,
        expectedVersion: row.expectedVersion,
        payloadHash: row.payloadHash,
        requesterId: row.requesterId,
        approverId: row.approverId,
        policyVersion: 'policy-1',
        createdAt: '2026-10-20T12:00:00.000Z',
        expiresAt: '2026-10-20T13:00:00.000Z',
        status: 'CONSUMED',
        operationId: input.operationId,
        kind: 'four_eyes',
        ...(row.founders === false
          ? { approverIsFounder: false, requesterIsFounder: true }
          : { approverIsFounder: true, requesterIsFounder: true }),
      } satisfies ActionApproval;
    },
  };
  return { consumer, calls };
}

const hideFields = { action: 'protocol.pool.hide', targetId: POOL_TARGET, reasonCode: 'scam_report', reason: 'reported by a user' };
const proposal = (over: Partial<Proposal & { founders?: boolean }> = {}) => ({
  actionType: 'protocol.pool.hide',
  targetId: POOL_TARGET,
  payloadHash: opsPayloadHash('protocol.pool.hide', hideFields),
  expectedVersion: 'listing:visible',
  requesterId: 'founder-a',
  approverId: 'founder-b',
  ...over,
});
const hideInput = (approvalId = 'ap_1') => ({
  chainId: CHAIN,
  poolAddress: POOL,
  reasonCode: 'scam_report',
  reason: 'reported by a user',
  approvalId,
});

function desk(
  proposals: Record<string, Proposal & { founders?: boolean }>,
  over: { store?: ListingStore; reasons?: readonly string[] | null } = {},
) {
  const store = over.store ?? new InMemoryListingStore();
  const id = identity(proposals);
  return {
    store,
    id,
    desk: new ProtocolOpsDesk({ store, approvals: id.consumer, reasonCodes: () => (over.reasons === undefined ? REASONS : over.reasons) }),
  };
}

describe('hide a pool', () => {
  it('applies after a second founder approves, and stores both signatures with the policy version', async () => {
    const { desk: d, store, id } = desk({ ap_1: proposal() });
    const result = await d.hidePool(hideInput());
    expect(result).toMatchObject({ action: 'protocol.pool.hide', state: 'hidden', outcome: 'applied', targetId: POOL_TARGET });
    expect(await store.state('pool', POOL_TARGET)).toMatchObject({
      state: 'hidden',
      reasonCode: 'scam_report',
      approvalId: 'ap_1',
      policyVersion: 'policy-1',
    });
    expect(await store.decision(result.idempotencyKey)).toMatchObject({
      requesterId: 'founder-a',
      approverId: 'founder-b',
      policyVersion: 'policy-1',
    });
    expect(id.calls[0]).toMatchObject({ targetService: 'svc-protocol', targetId: POOL_TARGET, expectedVersion: 'listing:visible' });
  });

  it('refuses owner.decision while the reason-code list is blank, and an unpublished code, before any approval is consumed', async () => {
    const blank = desk({ ap_1: proposal() }, { reasons: null });
    await expect(blank.desk.hidePool(hideInput())).rejects.toMatchObject({ code: 'owner.decision' });
    const empty = desk({ ap_1: proposal() }, { reasons: [] });
    await expect(empty.desk.hidePool(hideInput())).rejects.toBeInstanceOf(OpsRefusal);
    const unknown = desk({ ap_1: proposal() });
    await expect(unknown.desk.hidePool({ ...hideInput(), reasonCode: 'because' })).rejects.toMatchObject({
      code: 'protocol.ops_reason_code_unknown',
    });
    expect(unknown.id.calls).toHaveLength(0);
    expect(await unknown.store.state('pool', POOL_TARGET)).toBeNull();
  });

  it('changes nothing without an identity-issued approval: unwired identity, an empty id, an unknown approval', async () => {
    const store = new InMemoryListingStore();
    const unwired = new ProtocolOpsDesk({ store, approvals: unwiredApprovalConsumer, reasonCodes: () => REASONS });
    await expect(unwired.hidePool(hideInput())).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
    const { desk: d } = desk({}, { store });
    await expect(d.hidePool(hideInput(' '))).rejects.toMatchObject({ code: 'action_approval.missing' });
    await expect(d.hidePool(hideInput('ap_typed_name'))).rejects.toBeInstanceOf(ActionApprovalConsumeError);
    expect(await store.state('pool', POOL_TARGET)).toBeNull();
  });

  it('refuses when the proposer and the approver are not a distinct founder pair', async () => {
    for (const row of [proposal({ approverId: 'founder-a' }), proposal({ founders: false })]) {
      const { desk: d, store } = desk({ ap_1: row });
      await expect(d.hidePool(hideInput())).rejects.toMatchObject({ code: 'action_approval.not_founders' });
      expect(await store.state('pool', POOL_TARGET)).toBeNull();
    }
  });

  it('refuses an approval signed over a different reason or a different state', async () => {
    const other = desk({
      ap_1: proposal({ payloadHash: opsPayloadHash('protocol.pool.hide', { ...hideFields, reason: 'something else' }) }),
    });
    await expect(other.desk.hidePool(hideInput())).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
    const stale = desk({ ap_1: proposal({ expectedVersion: 'listing:hidden' }) });
    await expect(stale.desk.hidePool(hideInput())).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
  });

  it('returns the stored result on a retry with the same approval, consuming once and logging once', async () => {
    const { desk: d, id, store } = desk({ ap_1: proposal() });
    const first = await d.hidePool(hideInput());
    const again = await d.hidePool(hideInput());
    expect(again).toEqual(first);
    expect(id.calls).toHaveLength(1);
    expect((await store.list('pool')).length).toBe(1);
  });

  it('is a no-op with a note when a different approval hides the same pool, and still logs that decision', async () => {
    const { desk: d, store } = desk({ ap_1: proposal(), ap_2: proposal({ expectedVersion: 'listing:hidden' }) });
    await d.hidePool(hideInput('ap_1'));
    const second = await d.hidePool(hideInput('ap_2'));
    expect(second).toMatchObject({ outcome: 'noop', state: 'hidden', note: 'Already hidden by an earlier approval.' });
    expect(await store.state('pool', POOL_TARGET)).toMatchObject({ approvalId: 'ap_1' });
    expect(await store.decision(second.idempotencyKey)).not.toBeNull();
  });

  it('a crash after the consume and before the write hides nothing, and the replay writes the decision once', async () => {
    const inner = new InMemoryListingStore();
    let crash = true;
    const store: ListingStore = {
      state: (k, t) => inner.state(k, t),
      decision: (k) => inner.decision(k),
      list: (k) => inner.list(k),
      record: async (d, r) => {
        if (crash) {
          crash = false;
          throw new Error('connection lost');
        }
        return inner.record(d, r);
      },
    };
    const { desk: d, id } = desk({ ap_1: proposal() }, { store });
    await expect(d.hidePool(hideInput())).rejects.toThrow('connection lost');
    expect(await inner.state('pool', POOL_TARGET)).toBeNull();
    const replay = await d.hidePool(hideInput());
    expect(replay.outcome).toBe('applied');
    expect(id.calls.map((c) => c.operationId)).toEqual([replay.idempotencyKey, replay.idempotencyKey]);
    expect((await inner.list('pool')).length).toBe(1);
  });
});

describe('restore and market control', () => {
  const restoreFields = { action: 'protocol.pool.restore', targetId: POOL_TARGET };
  it('restores a hidden pool, and a restore of a visible pool is a no-op', async () => {
    const { desk: d, store } = desk({
      ap_1: proposal(),
      ap_2: proposal({
        actionType: 'protocol.pool.restore',
        payloadHash: opsPayloadHash('protocol.pool.restore', restoreFields),
        expectedVersion: 'listing:hidden',
      }),
      ap_3: proposal({
        actionType: 'protocol.pool.restore',
        payloadHash: opsPayloadHash('protocol.pool.restore', restoreFields),
        expectedVersion: 'listing:visible',
      }),
    });
    await d.hidePool(hideInput('ap_1'));
    expect(await d.restorePool({ chainId: CHAIN, poolAddress: POOL, approvalId: 'ap_2' })).toMatchObject({
      state: 'visible',
      outcome: 'applied',
    });
    expect(await d.restorePool({ chainId: CHAIN, poolAddress: POOL, approvalId: 'ap_3' })).toMatchObject({
      state: 'visible',
      outcome: 'noop',
    });
    expect((await store.state('pool', POOL_TARGET))?.state).toBe('visible');
  });

  it('delists a market by its upper-cased symbol and lists it as hidden', async () => {
    const fields = { action: 'protocol.market.delist', targetId: 'BTC-USDT', reasonCode: 'legal_request', reason: 'order received' };
    const { desk: d, store } = desk({
      ap_9: proposal({
        actionType: 'protocol.market.delist',
        targetId: 'BTC-USDT',
        payloadHash: opsPayloadHash('protocol.market.delist', fields),
      }),
    });
    const result = await d.delistMarket({ symbol: 'btc-usdt', reasonCode: 'legal_request', reason: 'order received', approvalId: 'ap_9' });
    expect(result).toMatchObject({ targetId: 'BTC-USDT', state: 'hidden', outcome: 'applied' });
    expect((await store.list('market')).map((r) => [r.targetId, r.state])).toEqual([['BTC-USDT', 'hidden']]);
  });
});

describe('labels', () => {
  const audit = { id: 'smart-accounts', audited: false };
  const network = (name: string): NetworkEntry => ({
    chainId: 1,
    name,
    kind: 'testnet',
    nativeCurrency: null,
    rpcUrls: null,
    blockTimeSeconds: null,
    explorerUrls: null,
    faucets: null,
    ecosystem: null,
  });
  it('lists every place the service serves a label or an audited flag, and passes honest ones', async () => {
    const { labelsOutput } = await import('./labels.js');
    const out = labelsOutput(
      serviceLabelEntries({ networks: [network('Base Sepolia test network')], configuredChainId: 84532, audit }),
      new Date(),
    );
    expect(out.verdict).toEqual({ pass: true, violations: [] });
    expect(out.entries.map((e) => e.where)).toEqual([
      'protocol.networks.list:1',
      'protocol.chainStatus:84532',
      'protocol.auditStatus:smart-accounts',
    ]);
  });
  it('turns FAIL on a planted mainnet claim or audited: true', async () => {
    const { labelsOutput } = await import('./labels.js');
    expect(
      labelsOutput(serviceLabelEntries({ networks: [network('INTACHAIN mainnet')], configuredChainId: 84532, audit }), new Date()).verdict
        .pass,
    ).toBe(false);
    expect(
      labelsOutput(serviceLabelEntries({ networks: [], configuredChainId: 84532, audit: { ...audit, audited: true } }), new Date()).verdict
        .violations,
    ).toEqual([{ where: 'protocol.auditStatus:smart-accounts', reason: 'audited_true' }]);
  });
});

describe('metrics', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const down = { status: 'down', reason: 'unreachable', message: 'x' } as const;
  it('reads a source that cannot be read as could not load with the time tried, never zero', () => {
    const out = buildMetrics({
      now,
      windowSeconds: 3600,
      indexer: down,
      dex: { status: 'down', reason: 'not_connected', message: 'x', code: 'edge.upstream_unwired' },
      chainReachable: null,
    });
    for (const reading of [out.quotes, out.wallets, out.refusalsByCode]) {
      expect(reading).toEqual({ status: 'could_not_load', triedAt: now.toISOString(), code: OPS_SOURCE_UNAVAILABLE });
    }
    expect(out.indexerLagBlocks).toMatchObject({ status: 'could_not_load', code: 'unreachable' });
    expect(out.window).toEqual({ from: '2026-10-20T11:00:00.000Z', to: now.toISOString() });
    expect(out.sections.find((s) => s.section === 'indexer')?.health).toBe('down');
    expect(out.sections.find((s) => s.section === 'chain')?.health).toBe('unknown');
  });
});

describe('ops over tRPC', () => {
  const SECRET = 'a-protocol-ops-desk-test-edge-secret-of-length';
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
  const principal = (scopes: string[]): Principal =>
    ({
      sub: '11111111-1111-4111-8111-111111111111',
      userId: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'none',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    }) as Principal;
  const as = (scopes: string[]) => {
    const raw = encodePrincipal(principal(scopes));
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-ops',
    });
  };
  const caller = (scopes: string[], over: Partial<ProtocolRouterDeps> = {}) => {
    const store = new InMemoryListingStore();
    const deps = {
      chain: { config: { chainId: 84532, factory: '0x0', implementation: '0x0' }, status: async () => ({ reachable: true }) },
      registry: {},
      relay: {},
      relayEnabled: () => true,
      ammFactoryAddress: () => '0x0',
      swapSlippageBps: () => null,
      ops: {
        store,
        desk: new ProtocolOpsDesk({ store, approvals: unwiredApprovalConsumer, reasonCodes: () => REASONS }),
        windowSeconds: () => undefined,
      },
      ...over,
    } as unknown as ProtocolRouterDeps;
    return createProtocolRouter(deps).createCaller(as(scopes));
  };

  it('keeps the desk behind the founder desk scopes', async () => {
    const reader = caller(['protocol:read']);
    await expect(reader.ops.pools.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.ops.labels()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(['admin:read']).ops.pools.hide(hideInput())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(['admin:read']).ops.pools.list()).resolves.toMatchObject({ pools: [] });
  });

  it('refuses a hide with action_approval.identity_unwired while identity cannot be reached, and lists nothing hidden', async () => {
    const api = caller(['admin:write', 'admin:read']);
    await expect(api.ops.pools.hide(hideInput())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('action_approval.identity_unwired'),
    });
    await expect(api.ops.pools.list()).resolves.toMatchObject({ pools: [] });
  });

  it('refuses the metrics read owner.decision while no window is published, and serves it once one is named', async () => {
    const api = caller(['admin:read']);
    await expect(api.ops.metrics()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('owner.decision'),
    });
    const out = await api.ops.metrics({ windowSeconds: 3600 });
    expect(out.quotes.status).toBe('could_not_load');
  });

  it('serves the label audit to the compliance scope with a PASS on the shipped registry', async () => {
    const out = await caller(['admin:compliance']).ops.labels();
    expect(out.verdict.pass).toBe(true);
    expect(out.entries.length).toBeGreaterThan(0);
  });
});
