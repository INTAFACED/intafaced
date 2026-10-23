import { describe, expect, it } from 'vitest';
import {
  approvalFor,
  checkIncidentDraft,
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

  it('the approval that decides a draft is the newest live one, else the newest of any', () => {
    const rows = [
      approval({ approvalId: 'old', status: 'CONSUMED', createdAt: '2026-10-23T10:00:00.000Z' }),
      approval({ approvalId: 'live', status: 'APPROVED', createdAt: '2026-10-23T10:01:00.000Z' }),
      approval({ approvalId: 'newest', status: 'REJECTED', createdAt: '2026-10-23T10:02:00.000Z' }),
    ].map((r) => publishApprovalOf(r)!);
    expect(approvalFor('root', rows)!.approvalId).toBe('live');
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
