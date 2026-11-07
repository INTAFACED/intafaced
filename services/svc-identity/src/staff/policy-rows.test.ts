import { describe, expect, it } from 'vitest';
import { readApprovalPolicies } from '../auth/action-approval-policy.js';
import { overlayPolicyRows } from './policy-rows.js';

const deployment = JSON.stringify({
  'ops.ledger.adjust': { requiredApprovals: '2', approverAudience: 'operator', applier: 'svc-ops', maxAgeSeconds: '600' },
  'identity.staff.invite': { requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '60' },
});
const row = (r: Record<string, string>, version = 1) => ({ row: r, version });

describe('console policy rows over the deployment setting (J-ops-console-09 #1)', () => {
  it('leaves the deployment setting alone when no row was set in the console', () => {
    expect(overlayPolicyRows(deployment, new Map())).toBe(deployment);
    expect(overlayPolicyRows(undefined, new Map())).toBeUndefined();
  });

  it('a console row stands in for its type and leaves the other types as deployed', () => {
    const merged = overlayPolicyRows(
      deployment,
      new Map([
        [
          'identity.staff.invite',
          row({ requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '600' }),
        ],
      ]),
    );
    const read = readApprovalPolicies(merged);
    expect(read['identity.staff.invite']).toMatchObject({ state: 'set', policy: { maxAgeSeconds: 600 } });
    expect(read['ops.ledger.adjust']).toMatchObject({ state: 'set', policy: { requiredApprovals: 2 } });
  });

  it('a blank count set in the console makes the type unset, even where the deployment had a whole row', () => {
    const merged = overlayPolicyRows(
      deployment,
      new Map([
        [
          'identity.staff.invite',
          row({ requiredApprovals: '', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '600' }),
        ],
      ]),
    );
    expect(readApprovalPolicies(merged)['identity.staff.invite']).toEqual({ state: 'unset' });
    expect(readApprovalPolicies(merged)['ops.ledger.adjust'].state).toBe('set');
  });

  it('drops a deployment key spelled another way, so a console row is never made ambiguous', () => {
    const odd = JSON.stringify({
      ' Identity.Staff.Invite ': { requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '60' },
    });
    const merged = overlayPolicyRows(
      odd,
      new Map([
        [
          'identity.staff.invite',
          row({ requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '900' }),
        ],
      ]),
    );
    expect(readApprovalPolicies(merged)['identity.staff.invite']).toMatchObject({ state: 'set', policy: { maxAgeSeconds: 900 } });
  });

  it('an unreadable deployment value keeps every deployed type unset and the console rows set', () => {
    const merged = overlayPolicyRows(
      '{not json',
      new Map([
        [
          'identity.staff.invite',
          row({ requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '600' }),
        ],
      ]),
    );
    const read = readApprovalPolicies(merged);
    expect(read['ops.ledger.adjust']).toEqual({ state: 'unset' });
    expect(read['identity.staff.invite'].state).toBe('set');
  });
});
