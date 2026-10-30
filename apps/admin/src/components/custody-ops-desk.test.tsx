import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustodyOpsView, TaskPanel } from './custody-ops-desk';
import type { CustodyOpsRead } from '@/lib/custody-ops/server-types';
import type { CustodyTask, CustodyTaskDetail } from '@/lib/custody-ops/model';

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-20T12:00:00Z');
const task = (over: Partial<CustodyTask> = {}): CustodyTask => ({
  id: '11111111-1111-4111-8111-111111111111',
  clientRef: 'r',
  kind: 'config',
  scope: 'policy',
  title: 'Publish policy',
  payload: { rule: 'two approvers' },
  payloadHash: 'abcdef0123456789'.repeat(4),
  initiator: OTHER,
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-20T18:00:00Z',
  createdAt: '2026-10-20T10:00:00Z',
  decidedAt: null,
  executedAt: null,
  ...over,
});
const detail = (over: Partial<CustodyTask> = {}): CustodyTaskDetail => ({
  ...task(over),
  timeline: [{ kind: 'submitted', actor: OTHER, detail: {}, at: '2026-10-20T10:00:00Z' }],
});
const read = (over: Partial<CustodyOpsRead> = {}): CustodyOpsRead => ({
  asOf: '2026-10-20T12:00:00Z',
  pending: { kind: 'ok', data: [task()] },
  recent: { kind: 'ok', data: [task({ status: 'executed', approvalCount: 2 })] },
  approvers: {
    kind: 'ok',
    data: [{ userId: ME, label: 'Ops lead', role: 'keyless', active: true, setBy: 'owner', setAt: '2026-10-19T00:00:00Z' }],
  },
  openItems: { kind: 'ok', data: { items: [], total: 0, sums: [] } },
  ...over,
});
const view = (r: CustodyOpsRead) =>
  renderToStaticMarkup(
    <CustodyOpsView read={r} userId={ME} now={NOW} pickedId={null} onPick={() => undefined} onRefresh={() => undefined} detail={null} />,
  );
const panel = (t: CustodyTaskDetail, busy = null) =>
  renderToStaticMarkup(
    <TaskPanel task={t} userId={ME} now={NOW} busy={busy} reply={null} onDecide={() => undefined} onClose={() => undefined} />,
  );

describe('the custody approvals desk', () => {
  it('shows what waits on the approver, recent tasks and the registered approvers, with the time it was read', () => {
    const html = view(read());
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Publish policy');
    expect(html).toContain('1 of 2 approvals');
    expect(html).toContain('6 h left');
    expect(html).toContain('Done');
    expect(html).toContain('Ops lead');
    expect(html).toContain('Key-less approver');
  });

  it('says so when nothing is waiting, and names a part that could not be read instead of showing an empty list', () => {
    const html = view(
      read({
        pending: { kind: 'ok', data: [] },
        recent: { kind: 'failed', message: 'svc-pay did not answer.', code: null, notBuilt: false, forbidden: false },
        approvers: { kind: 'ok', data: [] },
      }),
    );
    expect(html).toContain('Nothing is waiting on you.');
    expect(html).toContain('Tasks unavailable');
    expect(html).toContain('svc-pay did not answer.');
    expect(html).toContain('No approver is registered');
  });
});

describe('open custody items', () => {
  const item = {
    userId: OTHER,
    assetId: 'USDT',
    networkId: 'ethereum',
    outputIndex: 0,
    detectedAt: '2026-10-20T09:00:00Z',
  } as const;
  it('shows each item signed, why it is open, the sums by network and asset, and how many of how many', () => {
    const html = view(
      read({
        openItems: {
          kind: 'ok',
          data: {
            items: [
              {
                ...item,
                depositId: 'd1',
                kind: 'held',
                txHash: '0xaaaa',
                amount: '5',
                signedAmount: '5',
                status: 'below_minimum',
                reason: 'below_minimum',
              },
              {
                ...item,
                depositId: 'd2',
                kind: 'reversal_unfunded',
                txHash: '0xbbbb',
                amount: '30',
                signedAmount: '-30',
                status: 'needs_review',
                reason: 'reversal_unfunded',
              },
            ],
            total: 3,
            sums: [
              {
                networkId: 'ethereum',
                assetId: 'USDT',
                held: '5',
                heldCount: 1,
                reversalUnfunded: '30',
                reversalUnfundedCount: 1,
                net: '-25',
              },
            ],
          },
        },
      }),
    );
    expect(html).toContain('Open custody items');
    expect(html).toContain('5 USDT on ethereum');
    expect(html).toContain('-30 USDT on ethereum');
    expect(html).toContain('under the minimum deposit');
    expect(html).toContain('Taken back by the chain, not covered');
    expect(html).toContain('custody minus ledger -25');
    expect(html).toContain('Showing 2 of 3.');
    expect(html).toContain('data-testid="co-open-sum" data-network-id="ethereum" data-asset-id="USDT" data-net="-25"');
    expect(html).toContain('data-total="3"');
  });

  it('says plainly when there is none, and names the part when svc-pay refuses it', () => {
    expect(view(read())).toContain('data-testid="co-open-none"');
    const html = view(
      read({
        openItems: {
          kind: 'failed',
          message: 'svc-pay did not accept your founder session for this read.',
          code: 'operator.denied',
          notBuilt: false,
          forbidden: true,
        },
      }),
    );
    expect(html).toContain('Open custody items unavailable');
    expect(html).not.toContain('No open custody item');
  });
});

describe('one task', () => {
  it('shows the whole payload, the fingerprint and the timeline before any decision', () => {
    const html = panel(detail());
    expect(html).toContain('rule');
    expect(html).toContain('two approvers');
    expect(html).toContain('abcdef0123456789'.repeat(4));
    expect(html).toContain('Timeline');
    expect(html).toContain('Started');
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*>Reject<\/button>/);
  });

  it('turns approve and reject off for the person who started it, and cancel on', () => {
    const html = panel(detail({ initiator: ME }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Reject<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel task<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Cancel task<\/button>/);
  });

  it('turns every decision off once the task is no longer waiting', () => {
    const html = panel(detail({ status: 'executed' }));
    for (const name of ['Approve', 'Reject', 'Cancel task']) expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${name}</button>`));
  });
});
