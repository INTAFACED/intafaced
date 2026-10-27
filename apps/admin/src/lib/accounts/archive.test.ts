import { describe, expect, it, vi } from 'vitest';
import { archivedNote } from './archive-copy';

vi.mock('server-only', () => ({}));

const { archiveReply } = await import('./archive');

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const archive = {
  kind: 'identity.account.archive' as const,
  userId: USER,
  reasonCode: 'dormant' as const,
  reason: 'Closed two years ago, no contact since',
  version: '3',
};
const base = {
  auditId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
  userId: USER,
  reasonCode: 'dormant' as const,
  reason: archive.reason,
  occurredAt: '2026-10-24T18:00:00.000Z',
};
const state = (archivedAt: string | null, version: string, status: 'active' | 'closed' = 'closed') => ({
  userId: USER,
  version,
  status,
  archivedAt,
  archiveReasonCode: archivedAt ? ('dormant' as const) : null,
});

describe('what identity answered to an archive', () => {
  it('counts an archived record as done, names the approver and says it is read-only', () => {
    const reply = archiveReply(archive, {
      ...base,
      outcome: 'changed',
      changed: true,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: state(null, '3'),
      after: state('2026-10-24T18:00:00.000Z', '4'),
    });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('approved by 22222222') });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('read-only') });
  });
  it('shows an open account as identity refused it, in words', () => {
    const reply = archiveReply(archive, {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: FOUNDER,
      code: 'identity.archive_blocked_open_account',
      current: state(null, '3', 'active'),
    });
    expect(reply).toMatchObject({
      ok: false,
      refusal: { title: 'The account is still open', code: 'identity.archive_blocked_open_account', changed: 'no' },
    });
  });
  it('refuses an answer about another account or another reason code', () => {
    const refused = {
      ...base,
      outcome: 'refused' as const,
      changed: false as const,
      actorUserId: FOUNDER,
      code: 'identity.account_archived' as const,
      current: state('2026-10-24T18:00:00.000Z', '4'),
    };
    expect(archiveReply({ ...archive, userId: FOUNDER }, refused)).toMatchObject({
      ok: false,
      refusal: { code: 'admin.ops_invalid_response' },
    });
    expect(archiveReply({ ...archive, reasonCode: 'duplicate' }, refused)).toMatchObject({
      ok: false,
      refusal: { code: 'admin.ops_invalid_response' },
    });
  });
});

describe('what an archived record says on every control', () => {
  it('names the day and that the record is read-only, and nothing while it is not archived', () => {
    expect(archivedNote(null)).toBeNull();
    expect(archivedNote({ archivedAt: null })).toBeNull();
    expect(archivedNote({ archivedAt: '2026-10-24T18:00:00.000Z' })).toMatch(
      /^Archived on 2026-10-24: .*read-only.*identity\.account_archived/,
    );
  });
});
