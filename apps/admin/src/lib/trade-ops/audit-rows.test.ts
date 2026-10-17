import { describe, expect, it } from 'vitest';
import {
  auditRowsFromApprovalLog,
  auditRowsFromKillSwitch,
  auditRowsFromRestrictions,
  filterAudit,
  modulesOf,
  NO_FILTER,
  type AuditRow,
} from './audit-rows';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const row = (over: Partial<AuditRow>): AuditRow => ({
  id: 'x',
  at: '2026-10-17T11:30:00.000Z',
  actor: 'Alice',
  action: 'a',
  target: 't',
  module: 'trade',
  reason: null,
  outcome: 'Changed',
  requestId: null,
  ...over,
});

describe('converters', () => {
  it('kill switch: running/stopped words and the confirming operator', () => {
    const [r] = auditRowsFromKillSwitch([
      {
        at: '2026-10-17T11:00:00Z',
        module: 'trade',
        actor: 'a',
        confirmOperatorId: 'b',
        reason: 'because',
        previous: false,
        next: true,
        changed: true,
      },
    ]);
    expect(r).toMatchObject({
      actor: 'a (confirmed by b)',
      action: 'Kill switch: running to stopped',
      module: 'trade',
      outcome: 'Changed',
      at: '2026-10-17T11:00:00.000Z',
    });
  });
  it('restriction history: refusal keeps the service code', () => {
    const [r] = auditRowsFromRestrictions([
      {
        auditId: 'i',
        requestId: 'q',
        userId: 'u',
        at: '2026-10-17T11:00:00.000Z',
        actor: null,
        action: 'restrict',
        outcome: 'conflict',
        code: 'restriction.version_conflict',
        reason: 'r',
        versionBefore: '4',
        versionAfter: null,
        summary: '',
      },
    ]);
    expect(r).toMatchObject({ actor: 'not identified', outcome: 'Conflict: restriction.version_conflict', requestId: 'q' });
  });
  it('approval log: unknown stays unknown', () => {
    const [r] = auditRowsFromApprovalLog([
      {
        at: '2026-10-17T11:00:00Z',
        actorUserId: 'me',
        verb: 'approve',
        approvalId: 'a1',
        actionType: null,
        targetId: null,
        requesterId: null,
        reason: null,
        outcome: 'unknown',
        result: '',
      },
    ]);
    expect(r).toMatchObject({ action: 'Approve', outcome: 'Result unknown', module: 'approvals' });
  });
});

describe('filterAudit', () => {
  const rows = [
    row({ id: '1' }),
    row({ id: '2', actor: 'Bob', module: 'ledger', at: '2026-10-15T00:00:00.000Z' }),
    row({ id: '3', at: 'garbage' }),
  ];
  it('passes everything with no filter', () => expect(filterAudit(rows, NO_FILTER, NOW)).toHaveLength(3));
  it('matches actor by substring, any case', () =>
    expect(filterAudit(rows, { ...NO_FILTER, actor: 'bo' }, NOW).map((r) => r.id)).toEqual(['2']));
  it('filters by module', () => expect(filterAudit(rows, { ...NO_FILTER, module: 'ledger' }, NOW).map((r) => r.id)).toEqual(['2']));
  it('filters by window and drops unreadable times when a window is set', () => {
    expect(filterAudit(rows, { ...NO_FILTER, window: '24h' }, NOW).map((r) => r.id)).toEqual(['1']);
    expect(filterAudit(rows, { ...NO_FILTER, window: '7d' }, NOW).map((r) => r.id)).toEqual(['1', '2']);
  });
  it('lists modules once, sorted', () => expect(modulesOf(rows)).toEqual(['ledger', 'trade']));
});
