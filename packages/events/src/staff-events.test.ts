import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, STAFF_CHANGE_CAUSES, STAFF_CHANGED_FIELDS } from './catalog.js';

const byApproval = () => ({
  staffId: 'staff-1',
  actorId: 'staff-0',
  cause: 'approval' as const,
  approvalId: 'appr-1',
  changedFields: ['status', 'roleIds'],
  version: '4',
  at: new Date().toISOString(),
});

const accepted = () => ({
  staffId: 'staff-1',
  actorId: 'staff-1',
  cause: 'invite_accepted' as const,
  changedFields: ['status'],
  version: '2',
  at: new Date().toISOString(),
});

const events = () => [EVENT_CATALOG.staffCreated, EVENT_CATALOG.staffUpdated, EVENT_CATALOG.staffDeleted];

describe('OPS-admin-access-03 staff events', () => {
  it('declares created, updated and deleted under identity', () => {
    expect(EVENT_CATALOG.staffCreated.subject).toBe('intafaced.identity.staff.created');
    expect(EVENT_CATALOG.staffUpdated.subject).toBe('intafaced.identity.staff.updated');
    expect(EVENT_CATALOG.staffDeleted.subject).toBe('intafaced.identity.staff.deleted');
  });

  it('a four-eyes change needs the staff id, the actor and the approval spent', () => {
    expect([...STAFF_CHANGE_CAUSES]).toEqual(['approval', 'invite_accepted']);
    for (const event of events()) {
      expect(event.schema.safeParse(byApproval()).success).toBe(true);
      for (const field of ['staffId', 'actorId', 'cause', 'approvalId', 'changedFields', 'version', 'at'] as const) {
        const body: Record<string, unknown> = byApproval();
        delete body[field];
        expect(event.schema.safeParse(body).success, field).toBe(false);
      }
    }
  });

  it('an accepted invite is an update with no approval, and an approval id on it is refused', () => {
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse(accepted()).success).toBe(true);
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse({ ...accepted(), approvalId: 'appr-1' }).success).toBe(false);
    const parsed = EVENT_CATALOG.staffUpdated.schema.parse(accepted());
    expect('approvalId' in parsed && parsed.approvalId !== undefined).toBe(false);
  });

  it('created and deleted are never an accepted invite', () => {
    expect(EVENT_CATALOG.staffCreated.schema.safeParse(accepted()).success).toBe(false);
    expect(EVENT_CATALOG.staffDeleted.schema.safeParse(accepted()).success).toBe(false);
  });

  it('refuses a cause outside the list', () => {
    for (const event of events()) {
      expect(event.schema.safeParse({ ...byApproval(), cause: 'sync' }).success).toBe(false);
    }
  });

  it('names changed fields from a closed list, once each, including permissions for a role redefine', () => {
    expect([...STAFF_CHANGED_FIELDS]).toEqual(['status', 'roleIds', 'displayName', 'email', 'permissions']);
    expect(
      EVENT_CATALOG.staffUpdated.schema.safeParse({ ...byApproval(), changedFields: ['permissions'], roleId: 'r', roleVersion: '1' })
        .success,
    ).toBe(true);
    for (const event of events()) {
      expect(event.schema.safeParse({ ...byApproval(), changedFields: ['password'] }).success).toBe(false);
      expect(event.schema.safeParse({ ...byApproval(), changedFields: ['status', 'status'] }).success).toBe(false);
      expect(event.schema.safeParse({ ...byApproval(), version: 4 }).success).toBe(false);
    }
  });

  it('a role redefine update names the role and its version, for a business key that does not repeat', () => {
    const redefine = { ...byApproval(), changedFields: ['permissions'], roleId: 'role-7', roleVersion: '3' };
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse(redefine).success).toBe(true);
    // Two redefines of one role reach a holder whose record version did not move: the keys still differ.
    const key = (p: { staffId: string; version: string; roleId: string; roleVersion: string }) =>
      `identity.staff.updated:${p.staffId}:${p.version}:role:${p.roleId}:${p.roleVersion}`;
    expect(key(redefine)).not.toBe(key({ ...redefine, roleVersion: '4' }));
    // Required on a permissions-only update.
    const { roleId: _r, ...noRole } = redefine;
    const { roleVersion: _v, ...noVersion } = redefine;
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse(noRole).success).toBe(false);
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse(noVersion).success).toBe(false);
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse({ ...redefine, roleVersion: 3 }).success).toBe(false);
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse({ ...redefine, roleVersion: 'v3' }).success).toBe(false);
  });

  it('refuses roleId and roleVersion on every other payload', () => {
    const role = { roleId: 'role-7', roleVersion: '3' };
    for (const event of events()) {
      expect(event.schema.safeParse({ ...byApproval(), ...role }).success).toBe(false);
      expect(event.schema.safeParse({ ...byApproval(), roleId: 'role-7' }).success).toBe(false);
      expect(event.schema.safeParse({ ...byApproval(), changedFields: ['permissions', 'roleIds'], ...role }).success).toBe(false);
    }
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse({ ...accepted(), ...role }).success).toBe(false);
  });

  it('a permissions-only change is only ever a four-eyes update', () => {
    const redefine = { changedFields: ['permissions'], roleId: 'role-7', roleVersion: '3' };
    expect(EVENT_CATALOG.staffCreated.schema.safeParse({ ...byApproval(), ...redefine }).success).toBe(false);
    expect(EVENT_CATALOG.staffDeleted.schema.safeParse({ ...byApproval(), ...redefine }).success).toBe(false);
    expect(EVENT_CATALOG.staffUpdated.schema.safeParse({ ...accepted(), ...redefine }).success).toBe(false);
  });

  it('carries no secret or value on the bus', () => {
    for (const event of events()) {
      const parsed = event.schema.parse({
        ...byApproval(),
        password: 'hunter2',
        totpSecret: 'JBSWY3DP',
        email: 'ada@example.test',
        token: 't',
      });
      expect(Object.keys(parsed).sort()).toEqual(['actorId', 'approvalId', 'at', 'cause', 'changedFields', 'staffId', 'version']);
    }
    const parsed = EVENT_CATALOG.staffUpdated.schema.parse({ ...accepted(), password: 'hunter2' });
    expect(Object.keys(parsed).sort()).toEqual(['actorId', 'at', 'cause', 'changedFields', 'staffId', 'version']);
  });
});
