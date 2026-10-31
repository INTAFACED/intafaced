import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, STAFF_CHANGED_FIELDS } from './catalog.js';

const base = () => ({
  staffId: 'staff-1',
  actorId: 'staff-0',
  approvalId: 'appr-1',
  changedFields: ['status', 'roleIds'],
  version: '4',
  at: new Date().toISOString(),
});

const events = () => [EVENT_CATALOG.staffCreated, EVENT_CATALOG.staffUpdated, EVENT_CATALOG.staffDeleted];

describe('OPS-admin-access-03 staff events', () => {
  it('declares created, updated and deleted under identity', () => {
    expect(EVENT_CATALOG.staffCreated.subject).toBe('intafaced.identity.staff.created');
    expect(EVENT_CATALOG.staffUpdated.subject).toBe('intafaced.identity.staff.updated');
    expect(EVENT_CATALOG.staffDeleted.subject).toBe('intafaced.identity.staff.deleted');
  });

  it('needs the staff id, the actor and the approval spent', () => {
    for (const event of events()) {
      expect(event.schema.safeParse(base()).success).toBe(true);
      for (const field of ['staffId', 'actorId', 'approvalId', 'changedFields', 'version', 'at'] as const) {
        const body: Record<string, unknown> = base();
        delete body[field];
        expect(event.schema.safeParse(body).success, field).toBe(false);
      }
    }
  });

  it('names changed fields from a closed list, once each', () => {
    expect([...STAFF_CHANGED_FIELDS]).toEqual(['status', 'roleIds', 'displayName', 'email']);
    for (const event of events()) {
      expect(event.schema.safeParse({ ...base(), changedFields: ['password'] }).success).toBe(false);
      expect(event.schema.safeParse({ ...base(), changedFields: ['status', 'status'] }).success).toBe(false);
      expect(event.schema.safeParse({ ...base(), version: 4 }).success).toBe(false);
    }
  });

  it('carries no secret or value on the bus', () => {
    for (const event of events()) {
      const parsed = event.schema.parse({ ...base(), password: 'hunter2', totpSecret: 'JBSWY3DP', email: 'ada@example.test', token: 't' });
      expect(Object.keys(parsed).sort()).toEqual(['actorId', 'approvalId', 'at', 'changedFields', 'staffId', 'version']);
    }
  });
});
