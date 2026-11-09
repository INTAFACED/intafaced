import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APPROVAL_POLICY_SET_ACTION_TYPE } from '@intafaced/contracts';
import { staffChangeApprovalSubject, staffChangePayloadText } from '@intafaced/contracts/identity-staff';
import { payloadHashFor, proposeInputFor } from '@/lib/desk/approval-hash';
import { readDeskRequest } from '@/lib/desk/approval-packet';

// What the second founder approves must be byte for byte what svc-identity recomputes when it applies (J-ops-console-09).
describe('the staff invite and policy row hashes match svc-identity', () => {
  const invite = {
    kind: 'identity.staff.invite',
    requestId: 'staff-invite-0001',
    email: 'a.person@example.test',
    displayName: 'A Person',
  } as const;

  it('an invite is hashed over the named person, no roles, as identity hashes it', () => {
    const subject = staffChangeApprovalSubject('identity.staff.invite', {
      requestId: invite.requestId,
      email: invite.email,
      displayName: invite.displayName,
      roleIds: [],
    });
    const expected = `sha256:${createHash('sha256').update(staffChangePayloadText(subject)).digest('hex')}`;
    expect(payloadHashFor(invite)).toBe(expected);
    expect(proposeInputFor(invite)).toMatchObject({
      actionType: 'identity.staff.invite',
      targetService: 'svc-identity',
      targetId: 'invite:a.person@example.test',
      expectedVersion: '1',
      payloadHash: expected,
    });
  });

  it('a policy row change binds the type, the values as typed and the version read', () => {
    const request = {
      kind: 'identity.approval_policy.set',
      actionType: 'identity.staff.invite',
      requiredApprovals: '',
      approverAudience: 'founder',
      applier: 'svc-identity',
      maxAgeSeconds: '600',
      expectedVersion: '3',
    } as const;
    const fields = {
      actionType: 'identity.staff.invite',
      requiredApprovals: '',
      approverAudience: 'founder',
      applier: 'svc-identity',
      maxAgeSeconds: '600',
      expectedVersion: '3',
    };
    const expected = `sha256:${createHash('sha256')
      .update(JSON.stringify({ targetId: APPROVAL_POLICY_SET_ACTION_TYPE, ...fields }))
      .digest('hex')}`;
    expect(payloadHashFor(request)).toBe(expected);
    expect(payloadHashFor({ ...request, maxAgeSeconds: '601' })).not.toBe(expected);
    expect(proposeInputFor(request)).toMatchObject({
      actionType: APPROVAL_POLICY_SET_ACTION_TYPE,
      targetId: APPROVAL_POLICY_SET_ACTION_TYPE,
    });
  });

  it('the packet reader keeps a blank count and refuses an untrimmed value or an unknown type', () => {
    const base = {
      kind: 'identity.approval_policy.set',
      actionType: 'identity.staff.invite',
      requiredApprovals: '',
      approverAudience: 'founder',
      applier: 'svc-identity',
      maxAgeSeconds: '600',
      expectedVersion: '0',
    };
    expect(readDeskRequest(base)).toEqual(base);
    expect(readDeskRequest({ ...base, applier: ' svc-identity' })).toBeNull();
    expect(readDeskRequest({ ...base, actionType: 'pay.payout' })).toBeNull();
    expect(readDeskRequest(invite)).toEqual(invite);
    expect(readDeskRequest({ ...invite, email: 'A.Person@example.test' })).toBeNull();
    expect(readDeskRequest({ ...invite, openLink: true })).toBeNull();
  });
});
