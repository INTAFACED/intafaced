import { describe, expect, it } from 'vitest';
import {
  approvalFor,
  checkIncidentDraft,
  checkPostmortem,
  postmortemTarget,
  readPostmortems,
  incidentsFrom,
  publishApprovalOf,
  readOperatorNotices,
  templateGroups,
  type OperatorNotice,
} from './incidents-model';

const notice = (over: Partial<OperatorNotice>): OperatorNotice => ({
  id: 'root',
  kind: 'incident',
  title: 'TEST payments slow',
  body: 'TEST looking',
  status: 'published',
  publishedAt: '2026-10-23T10:00:00.000Z',
  version: 1,
  impact: 'minor',
  components: ['payments'],
  parentId: null,
  resolves: false,
  authorId: 'a',
  createdAt: '2026-10-23T10:00:00.000Z',
  ...over,
});
const approval = (over: Record<string, unknown>) => ({
  approvalId: 'x',
  operationId: 'op',
  targetId: 'root',
  status: 'PENDING',
  requesterId: 'a',
  approverId: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  ...over,
});

describe('incident desk model', () => {
  it('an incident is its first entry and its updates in order; a draft first entry is a draft incident', () => {
    const [draft] = incidentsFrom([notice({ id: 'd', status: 'draft', publishedAt: null })]);
    expect(draft!.state).toBe('draft');
    const [open] = incidentsFrom([
      notice({ id: 'u2', parentId: 'root', createdAt: '2026-10-23T10:02:00.000Z' }),
      notice({}),
      notice({ id: 'u1', parentId: 'root', createdAt: '2026-10-23T10:01:00.000Z' }),
    ]);
    expect(open!.entries.map((e) => e.id)).toEqual(['root', 'u1', 'u2']);
    expect(open!.state).toBe('open');
  });

  it('only a published resolving update resolves it; a drafted one does not', () => {
    const drafted = incidentsFrom([notice({}), notice({ id: 'r', parentId: 'root', resolves: true, status: 'draft', publishedAt: null })]);
    expect(drafted[0]!.state).toBe('open');
    expect(incidentsFrom([notice({}), notice({ id: 'r', parentId: 'root', resolves: true })])[0]!.state).toBe('resolved');
  });

  it('the approval that decides a draft is the newest approved, then the newest pending, else the newest of any', () => {
    const rows = [
      approval({ approvalId: 'old', status: 'CONSUMED', createdAt: '2026-10-23T10:00:00.000Z' }),
      approval({ approvalId: 'live', status: 'APPROVED', createdAt: '2026-10-23T10:01:00.000Z' }),
      approval({ approvalId: 'newest', status: 'REJECTED', createdAt: '2026-10-23T10:02:00.000Z' }),
      approval({ approvalId: 'asked-later', status: 'PENDING', createdAt: '2026-10-23T10:03:00.000Z' }),
    ].map((r) => publishApprovalOf(r)!);
    // A newer request never hides an approval that can be spent.
    expect(approvalFor('root', rows)!.approvalId).toBe('live');
    expect(
      approvalFor(
        'root',
        rows.filter((r) => r.approvalId !== 'live'),
      )!.approvalId,
    ).toBe('asked-later');
    rows.pop();
    expect(
      approvalFor(
        'root',
        rows.filter((r) => r.approvalId !== 'live'),
      )!.approvalId,
    ).toBe('newest');
    expect(approvalFor('other', rows)).toBeNull();
  });

  it('an incident that names components has to name its impact; an update does not', () => {
    const base = { title: 'TEST', body: 'TEST', impact: null, components: ['payments'], parentId: null, resolves: false };
    expect(checkIncidentDraft(base)).toMatchObject({ ok: false });
    expect(checkIncidentDraft({ ...base, parentId: 'root', components: [] })).toEqual({ ok: true });
    expect(checkIncidentDraft({ ...base, body: '  ' })).toMatchObject({ ok: false });
  });

  it('a list the console cannot read is refused whole, never half shown', () => {
    expect(readOperatorNotices([notice({}), { ...notice({}), impact: 'severe' }])).toBeNull();
    expect(readOperatorNotices([notice({})])).toHaveLength(1);
    expect(publishApprovalOf({ approvalId: 'x' })).toBeNull();
  });

  it('a postmortem list is read whole or not at all, and its approval is found by its own target', () => {
    const row = {
      incidentId: 'root',
      body: 'TEST',
      version: 2,
      status: 'draft',
      writtenBy: 'a',
      writtenAt: '2026-10-23T11:00:00.000Z',
      publishedAt: null,
    };
    expect(readPostmortems([row])).toEqual([row]);
    expect(readPostmortems([row, { ...row, status: 'live' }])).toBeNull();
    expect(readPostmortems({})).toBeNull();
    expect(checkPostmortem('  ')).toEqual({ ok: false, why: expect.stringContaining('1 to 20000') });
    expect(checkPostmortem('x'.repeat(20_001)).ok).toBe(false);
    expect(checkPostmortem('TEST').ok).toBe(true);
    const base = {
      operationId: 'o',
      requesterId: 'a',
      approverId: null,
      createdAt: '2026-10-23T10:00:00.000Z',
    };
    const approvals = [
      { ...base, approvalId: 'notice', targetId: 'root', status: 'APPROVED' },
      { ...base, approvalId: 'pm', targetId: postmortemTarget('root'), status: 'PENDING' },
    ];
    expect(approvalFor(postmortemTarget('root'), approvals)?.approvalId).toBe('pm');
    expect(approvalFor('root', approvals)?.approvalId).toBe('notice');
  });

  it('templates without a group are listed under No group', () => {
    const t = { title: 'T', body: 'B', impact: null, components: [], definedAt: '2026-10-23T10:00:00.000Z' };
    expect(
      templateGroups([
        { ...t, id: 'a', name: 'A', group: null },
        { ...t, id: 'b', name: 'B', group: 'Payments' },
      ]).map((g) => g.group),
    ).toEqual(['No group', 'Payments']);
  });
});
