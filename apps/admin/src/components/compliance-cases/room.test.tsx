import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ComplianceCase } from '@intafaced/contracts';
import { parseRoomQuery } from '@/lib/compliance-cases/model';
import type { CaseRoom } from '@/lib/compliance-cases/read';
import { CasesRoom } from './room';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const c = (id: string, over: Partial<ComplianceCase> = {}): ComplianceCase => ({
  id,
  name: `TEST case ${id}`,
  kind: 'manual',
  type: 'alert',
  subjectId: 'u1',
  entityType: 'user',
  inboxId: 'inb_1',
  status: 'pending',
  reviewLevel: null,
  assignee: null,
  tags: [],
  snoozedUntil: null,
  dueAt: null,
  createdAt: '2026-10-20T01:00:00.000Z',
  updatedAt: '2026-10-20T01:00:00.000Z',
  ...over,
});

const inbox = {
  inbox: {
    id: 'inb_1',
    name: 'screening',
    version: 1,
    entityType: 'user' as const,
    workflow: 'standard',
    filter: {},
    owner: 'u9',
    createdAt: '2026-10-20T00:00:00.000Z',
  },
  member: true,
  favourite: true,
  openCount: 2,
};

const base: CaseRoom = {
  asOf: '2026-10-20T12:00:00.000Z',
  inboxes: { kind: 'ok', data: [inbox] },
  list: null,
  preview: null,
  nextEmpty: false,
  access: null,
};
const html = (room: CaseRoom, q: Record<string, string> = {}) => renderToStaticMarkup(<CasesRoom room={room} q={parseRoomQuery(q)} />);
const failed = (code: string | null, message = 'nope') => ({ kind: 'failed' as const, message, code, notBuilt: false, forbidden: false });

describe('case room', () => {
  it('lists the inboxes, marks the favourite, and asks for an inbox before showing cases', () => {
    const out = html(base);
    expect(out).toContain('screening v1');
    expect(out).toContain('2 open');
    expect(out).toContain('pick-inbox');
    expect(out).toContain('jump-form');
    expect(out).toContain('define-queue');
  });

  it('shows rows, the service total and the groups, with "Not set" for blank due dates and review levels', () => {
    const out = html(
      {
        ...base,
        list: {
          kind: 'ok',
          data: {
            rows: [c('a'), c('b', { reviewLevel: 'red', assignee: 'u2' })],
            total: 120,
            nextCursor: 'cur',
            groups: { green: 0, yellow: 0, red: 1, unset: 1 },
          },
        },
      },
      { inbox: 'inb_1', limit: '2' },
    );
    expect(out).toContain('120 cases');
    expect(out).toContain('Not set');
    expect(out).toContain('Red');
    expect(out).toContain('cases-groups');
    expect(out).toContain('cursor=cur');
    expect(out).toContain('limit=2');
  });

  it('says svc-ops reports nothing, and invents no row', () => {
    const out = html(
      { ...base, list: { kind: 'ok', data: { rows: [], total: 0, nextCursor: null, groups: null } } },
      { inbox: 'inb_1', limit: '2' },
    );
    expect(out).toContain('cases-empty');
    expect(out).not.toContain('case-row');
  });

  it('shows the access panel naming the owner, and no rows', () => {
    const out = html(
      {
        ...base,
        list: failed('compliance.inbox_forbidden'),
        access: { kind: 'ok', data: { inboxId: 'inb_9', name: 'secret', owner: 'owner-1', member: false } },
      },
      { inbox: 'inb_9' },
    );
    expect(out).toContain('Ask an admin for access');
    expect(out).toContain('owner-1');
    expect(out).not.toContain('cases-table');
  });

  it('asks for a page size when none is set instead of assuming one', () => {
    const out = html({ ...base, list: failed('compliance.cases_list_limit_unset') }, { inbox: 'inb_1' });
    expect(out).toContain('limit-form');
    expect(out).toContain('Cases per page');
  });

  it('says a down service did not answer instead of showing an empty inbox', () => {
    const out = html({ ...base, inboxes: failed(null, 'svc-ops did not answer.') });
    expect(out).toContain('inboxes-failed');
    expect(out).not.toContain('inboxes-empty');
  });

  it('shows an honest empty for next unassigned, and a typed not-found for a jumped id', () => {
    expect(html({ ...base, nextEmpty: true }, { inbox: 'inb_1', next: '1' })).toContain('next-empty');
    expect(html({ ...base, preview: failed('compliance.case_not_found') }, { case: 'zzz' })).toContain('preview-failed');
  });

  it('shows the preview of a case', () => {
    const out = html({ ...base, preview: { kind: 'ok', data: c('a', { assignee: 'u2', tags: ['x'] }) } }, { case: 'a' });
    expect(out).toContain('case-preview');
    expect(out).toContain('u2');
  });
});
