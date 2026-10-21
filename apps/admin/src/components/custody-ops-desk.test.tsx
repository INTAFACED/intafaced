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
