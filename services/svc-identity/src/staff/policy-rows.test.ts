import { describe, expect, it } from 'vitest';
import { readApprovalPolicies } from '../auth/action-approval-policy.js';
import type { Sql } from 'postgres';
import { ConsolePolicyRows, overlayPolicyRows } from './policy-rows.js';

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

/** A stand-in for the one SELECT the rows read: it answers `found`, or throws while `fail` is set. */
function fakeSql(found: Array<{ action_type: string; row: unknown; version: number }>, state: { fail: boolean }): Sql {
  return (async () => {
    if (state.fail) throw new Error('database unreachable');
    return found;
  }) as unknown as Sql;
}

const WHOLE = { requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '600' };

describe('ConsolePolicyRows', () => {
  it('never reads a stored row for a ledger correction type: those stay deployment-only', async () => {
    const state = { fail: false };
    const rows = new ConsolePolicyRows(
      fakeSql(
        [{ action_type: 'ops.ledger.adjust', row: { ...WHOLE, approverAudience: 'founder', applier: 'svc-ops' }, version: 4 }],
        state,
      ),
      () => deployment,
    );
    await rows.refresh();
    expect(rows.source('ops.ledger.adjust')).toMatchObject({
      state: 'set',
      policy: { requiredApprovals: 2, approverAudience: 'operator' },
    });
    expect(rows.entries().find((e) => e.actionType === 'ops.ledger.adjust')).toMatchObject({ source: 'deployment', rowVersion: '0' });
  });

  it('a console row stands for its staff type once read', async () => {
    const rows = new ConsolePolicyRows(
      fakeSql([{ action_type: 'identity.staff.invite', row: WHOLE, version: 2 }], { fail: false }),
      () => undefined,
    );
    await rows.refresh();
    expect(rows.source('identity.staff.invite')).toMatchObject({ state: 'set', policy: { maxAgeSeconds: 600 } });
    expect(rows.entries().find((e) => e.actionType === 'identity.staff.invite')).toMatchObject({ source: 'console', rowVersion: '2' });
  });

  it('fails closed when the last good read is too old: every staff type reads unset, and the failure is logged', async () => {
    let now = 1_000_000;
    const state = { fail: false };
    const warned: string[] = [];
    const rows = new ConsolePolicyRows(
      fakeSql([{ action_type: 'identity.staff.invite', row: WHOLE, version: 1 }], state),
      () => deployment,
      {
        staleAfterMs: 30_000,
        clock: () => now,
        warn: (_obj, msg) => warned.push(msg),
      },
    );
    await rows.refresh();
    expect(rows.source('identity.staff.invite').state).toBe('set');
    state.fail = true;
    await expect(rows.refresh()).rejects.toThrow('database unreachable');
    now += 29_000;
    expect(rows.source('identity.staff.invite').state).toBe('set');
    now += 2_000;
    expect(rows.stale()).toBe(true);
    expect(rows.source('identity.staff.invite')).toEqual({ state: 'unset' });
    // The deployment's own staff row does not come back either: a stale instance judges every staff type unset.
    expect(rows.source('identity.staff.disable')).toEqual({ state: 'unset' });
    // The ledger rows are the deployment's and are unaffected.
    expect(rows.source('ops.ledger.adjust').state).toBe('set');
    rows.start(5);
    await new Promise((r) => setTimeout(r, 30));
    rows.stop();
    expect(warned).toContain('identity.approval_policy_rows_refresh_failed');
    state.fail = false;
    await rows.refresh();
    expect(rows.source('identity.staff.invite').state).toBe('set');
  });

  it('is stale before its first read, so nothing set in the console is judged by an empty map', () => {
    const rows = new ConsolePolicyRows(fakeSql([], { fail: false }), () => deployment);
    expect(rows.source('identity.staff.invite')).toEqual({ state: 'unset' });
  });
});
