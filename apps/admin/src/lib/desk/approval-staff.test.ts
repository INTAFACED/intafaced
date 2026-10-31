import { describe, expect, it } from 'vitest';
import {
  IDENTITY_STAFF_ACTION_TYPES,
  IDENTITY_STAFF_REFUSAL_CODES,
  staffChangeApprovalSubject,
  staffPermissionSchema,
} from '@intafaced/contracts/identity-staff';
import { identityActionPayloadHash } from '../../../../../services/svc-identity/src/auth/privileged-dual-control';
import {
  confirmPhrase,
  decodePacket,
  describeRequest,
  encodePacket,
  readDeskRequest,
  requestReason,
  type DeskRequest,
} from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';
import { STAFF_REQUEST_KINDS, staffRequestId, staffSubjectFor, type StaffDeskRequest } from './approval-staff';
import { explainRefusal, isKnownCode } from './refusal-copy';
import { STAFF_AREAS, STAFF_ENVS, STAFF_VERBS, permissionOf } from '@/lib/system-staff/model';

/** The six staff changes (OPS-admin-access-03) as two-founder desk requests. TEST values only. */
const STAFF = 'stf_test_0001';
const invite: DeskRequest = {
  kind: 'identity.staff.invite',
  email: 'test.person@example.test',
  displayName: 'TEST Person',
  roleIds: ['role_b', 'role_a'],
};
const disable: DeskRequest = { kind: 'identity.staff.disable', staffId: STAFF, reason: 'TEST left the company', version: '4' };
const remove: DeskRequest = { kind: 'identity.staff.remove', staffId: STAFF, reason: 'TEST duplicate record', version: '4' };
const defineNew: DeskRequest = {
  kind: 'identity.roles.define',
  roleId: null,
  version: null,
  name: 'TEST ops reader',
  allow: ['staff:ledger:read:production'],
  deny: ['staff:ledger:write:production'],
};
const redefine: DeskRequest = { ...defineNew, roleId: 'role_a', version: '2' } as DeskRequest;
const assign: DeskRequest = { kind: 'identity.roles.assign', staffId: STAFF, roleId: 'role_a', version: '4' };
const unassign: DeskRequest = { kind: 'identity.roles.unassign', staffId: STAFF, roleId: 'role_a', version: '4' };
const ALL = [invite, disable, remove, defineNew, redefine, assign, unassign];

describe('staff request kinds', () => {
  it('are exactly the identity action types they spend', () => {
    expect([...STAFF_REQUEST_KINDS]).toEqual([...IDENTITY_STAFF_ACTION_TYPES]);
  });

  it('survive the packet and read back only in their exact shape', () => {
    for (const request of ALL) {
      const packet = { request, approvalId: 'appr_T', operationId: 'op_T', expiresAt: '2026-10-31T06:00:00.000Z', requesterId: 'u_T' };
      expect(decodePacket(encodePacket(packet))).toEqual({ ok: true, packet });
      expect(readDeskRequest({ ...request, extra: true })).toBeNull();
    }
  });

  it('an invite names one person in the contract’s normal form and never carries a link', () => {
    expect(readDeskRequest({ ...invite, email: 'TEST.Person@Example.test' })).toBeNull();
    expect(readDeskRequest({ ...invite, email: ' test.person@example.test' })).toBeNull();
    expect(readDeskRequest({ ...invite, email: '' })).toBeNull();
    expect(readDeskRequest({ ...invite, email: 'not-an-email' })).toBeNull();
    expect(readDeskRequest({ ...invite, displayName: '' })).toBeNull();
    expect(readDeskRequest({ ...invite, openLink: true })).toBeNull();
    expect(readDeskRequest({ ...invite, inviteLink: 'https://x.test/join' })).toBeNull();
    expect(readDeskRequest({ ...invite, roleIds: ['role_a', 'role_a'] })).toBeNull();
    expect(describeRequest(invite)).toContain('no link anyone could use');
  });

  it('a role define refuses built-in names, an empty role, overlap and anything outside the catalogue', () => {
    expect(readDeskRequest({ ...defineNew, name: 'Founder' })).toBeNull();
    expect(readDeskRequest({ ...defineNew, allow: [], deny: [] })).toBeNull();
    expect(readDeskRequest({ ...defineNew, deny: ['staff:ledger:read:production'] })).toBeNull();
    expect(readDeskRequest({ ...defineNew, allow: ['staff:ledger:read:prod'] })).toBeNull();
    expect(readDeskRequest({ ...defineNew, roleId: 'role_a' })).toBeNull();
    expect(readDeskRequest({ ...defineNew, version: '2' })).toBeNull();
  });

  it('disable and remove carry a reason; the others do not', () => {
    expect(readDeskRequest({ ...disable, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...disable, version: '04' })).toBeNull();
    expect(requestReason(disable)).toBe('TEST left the company');
    expect(requestReason(remove)).toBe('TEST duplicate record');
    for (const r of [invite, defineNew, assign, unassign]) expect(requestReason(r)).toBeNull();
  });

  it('each phrase names who or what changes', () => {
    expect(confirmPhrase(invite)).toBe('INVITE test.person@example.test');
    expect(confirmPhrase(disable)).toBe('DISABLE STAFF stf_test');
    expect(confirmPhrase(remove)).toBe('REMOVE STAFF stf_test');
    expect(confirmPhrase(defineNew)).toBe('DEFINE ROLE TEST OPS READER');
    expect(confirmPhrase(redefine)).toBe('REDEFINE ROLE role_a');
    expect(confirmPhrase(assign)).toBe('ASSIGN ROLE role_a TO stf_test');
    expect(confirmPhrase(unassign)).toBe('UNASSIGN ROLE role_a FROM stf_test');
  });

  it('a role naming the whole catalogue still fits one packet', () => {
    const every = STAFF_AREAS.flatMap((a) => STAFF_VERBS.flatMap((v) => STAFF_ENVS.map((e) => permissionOf(a, v, e))));
    expect(every).toHaveLength(264);
    for (const p of every) expect(staffPermissionSchema.safeParse(p).success).toBe(true);
    const big: DeskRequest = { ...defineNew, allow: every.slice(0, 200), deny: every.slice(200) } as DeskRequest;
    const packet = { request: big, approvalId: 'appr_T', operationId: 'op_T', expiresAt: '2026-10-31T06:00:00.000Z', requesterId: 'u_T' };
    expect(decodePacket(encodePacket(packet))).toEqual({ ok: true, packet });
  });
});

describe('staff approvals bind to the contract’s subject, hashed the way svc-identity hashes', () => {
  it('the hash is identity’s { targetId, ...fields } over staffChangeApprovalSubject', () => {
    for (const request of ALL as StaffDeskRequest[]) {
      const subject = staffSubjectFor(request);
      expect(payloadHashFor(request)).toBe(identityActionPayloadHash(subject.targetId, subject.fields as Record<string, string>));
    }
  });

  it('matches the contract subject computed from the raw fields, whatever the role order', () => {
    const subject = staffChangeApprovalSubject('identity.staff.invite', {
      requestId: 'console:any-request-id',
      email: 'test.person@example.test',
      displayName: 'TEST Person',
      roleIds: ['role_a', 'role_b'],
    });
    expect(staffSubjectFor(invite as StaffDeskRequest)).toEqual(subject);
    expect(payloadHashFor({ ...invite, roleIds: ['role_a', 'role_b'] } as DeskRequest)).toBe(payloadHashFor(invite));
    expect(payloadHashFor({ ...disable, reason: 'TEST another reason here' } as DeskRequest)).not.toBe(payloadHashFor(disable));
    expect(payloadHashFor({ ...assign, version: '5' } as DeskRequest)).not.toBe(payloadHashFor(assign));
  });

  it('proposes the staff action type against svc-identity, the contract’s target and the version read', () => {
    expect(proposeInputFor(invite)).toMatchObject({
      actionType: 'identity.staff.invite',
      targetService: 'svc-identity',
      targetId: 'invite:test.person@example.test',
      expectedVersion: '0',
      policyVersion: 'v1',
    });
    expect(proposeInputFor(disable)).toMatchObject({
      actionType: 'identity.staff.disable',
      targetId: `staff:${STAFF}`,
      expectedVersion: '4',
    });
    expect(proposeInputFor(remove)).toMatchObject({ actionType: 'identity.staff.remove', targetId: `staff:${STAFF}` });
    expect(proposeInputFor(defineNew)).toMatchObject({
      actionType: 'identity.roles.define',
      targetId: 'role:new:test ops reader',
      expectedVersion: '0',
    });
    expect(proposeInputFor(redefine)).toMatchObject({ targetId: 'role:role_a', expectedVersion: '2' });
    expect(proposeInputFor(assign)).toMatchObject({
      actionType: 'identity.roles.assign',
      targetId: `staff:${STAFF}`,
      expectedVersion: '4',
    });
    expect(proposeInputFor(unassign)).toMatchObject({ actionType: 'identity.roles.unassign' });
    for (const r of ALL) expect(proposeInputFor(r).payloadHash).toBe(payloadHashFor(r));
  });

  it('the request id is the business key of the action and the approval, never random', () => {
    expect(staffRequestId('identity.staff.disable', 'appr_T')).toBe('console:identity.staff.disable:appr_T');
    expect(staffRequestId('identity.staff.disable', 'appr_T')).toBe(staffRequestId('identity.staff.disable', 'appr_T'));
  });
});

describe('the console’s refusal map covers every staff refusal', () => {
  it('every code in IDENTITY_STAFF_REFUSAL_CODES has its own words and changed nothing', () => {
    const titles = new Set<string>();
    for (const code of IDENTITY_STAFF_REFUSAL_CODES) {
      expect(isKnownCode(code), code).toBe(true);
      const view = explainRefusal(code, 409);
      expect(view.code).toBe(code);
      expect(view.changed).toBe('no');
      titles.add(view.title);
    }
    expect(titles.size).toBe(IDENTITY_STAFF_REFUSAL_CODES.length);
  });

  it('an identity without the roster is named plainly, with no approval spent', () => {
    const view = explainRefusal('admin.staff_roster_not_built', 404, false);
    expect(view.body).toContain('svc-identity has no staff roster yet (OPS-admin-access-03 step 2)');
    expect(view.body).toContain('No approval was spent');
    expect(view.changed).toBe('no');
  });
});
