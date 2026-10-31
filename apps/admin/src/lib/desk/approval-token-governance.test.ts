import { describe, expect, it } from 'vitest';
import { tokenActionPayloadHash } from '../../../../../services/svc-token/src/action-approval-consume';
import {
  GOVERNANCE_ROLES as TOKEN_GOVERNANCE_ROLES,
  GOVERNANCE_ROLE_ACTION,
  GOVERNANCE_SETTINGS_ACTION,
  governanceRolePayload,
  governanceSettingsPayload,
} from '../../../../../services/svc-token/src/governance-payload';
import { payloadHashFor, proposeInputFor } from './approval-hash';
import { confirmPhrase, describeRequest, readDeskRequest, requestReason } from './approval-packet';
import { GOVERNANCE_ROLES, durationWords, hoursToMs, msToHours } from '@/lib/token-governance/model';

/** J-more-catalogue-10: the console's governance requests hash exactly as svc-token consumes them. */
describe('token governance desk requests', () => {
  it('pins the settings hash and propose input to svc-token, with a blank figure as the empty string', () => {
    for (const [d, p, revision] of [
      ['0', '86400000', '0'],
      ['', '86400000', '3'],
      ['', '', '4'],
    ] as const) {
      const request = readDeskRequest({ kind: 'token.governance.settings.set', votingDelayMs: d, votingPeriodMs: p, revision });
      expect(request).not.toBeNull();
      const expected = tokenActionPayloadHash(
        GOVERNANCE_SETTINGS_ACTION,
        governanceSettingsPayload({ votingDelayMs: d || null, votingPeriodMs: p || null, expectedRevision: Number(revision) }),
      );
      expect(payloadHashFor(request!)).toBe(expected);
      expect(proposeInputFor(request!)).toEqual({
        actionType: GOVERNANCE_SETTINGS_ACTION,
        targetService: 'svc-token',
        targetId: GOVERNANCE_SETTINGS_ACTION,
        expectedVersion: revision,
        payloadHash: expected,
        policyVersion: 'v1',
      });
      expect(requestReason(request!)).toBeNull();
      expect(confirmPhrase(request!)).toBe('GOVERNANCE SETTINGS');
    }
  });

  it('pins the role hash, and a revoke is the empty role', () => {
    for (const [role, revision] of [
      ['moderator', '0'],
      ['', '1'],
    ] as const) {
      const request = readDeskRequest({ kind: 'token.governance.role.set', userId: 'acct-1', role, revision });
      const expected = tokenActionPayloadHash(
        GOVERNANCE_ROLE_ACTION,
        governanceRolePayload({ userId: 'acct-1', role: role || null, expectedRevision: Number(revision) }),
      );
      expect(payloadHashFor(request!)).toBe(expected);
      expect(proposeInputFor(request!)).toMatchObject({ actionType: GOVERNANCE_ROLE_ACTION, expectedVersion: revision });
    }
    expect(confirmPhrase(readDeskRequest({ kind: 'token.governance.role.set', userId: 'acct-1', role: '', revision: '1' })!)).toBe(
      'ROLE acct-1 NONE',
    );
  });

  it("knows exactly svc-token's roles", () => {
    expect(GOVERNANCE_ROLES).toEqual(TOKEN_GOVERNANCE_ROLES);
  });

  it('reads only what svc-token can run', () => {
    const ok = { kind: 'token.governance.settings.set', votingDelayMs: '0', votingPeriodMs: '3600000', revision: '0' };
    expect(readDeskRequest(ok)).not.toBeNull();
    for (const bad of [
      { ...ok, votingPeriodMs: '0' },
      { ...ok, votingDelayMs: '-1' },
      { ...ok, votingDelayMs: '1.5' },
      { ...ok, revision: '01' },
      { ...ok, extra: 'x' },
      { kind: 'token.governance.role.set', userId: 'acct-1', role: 'owner', revision: '0' },
      { kind: 'token.governance.role.set', userId: 'acct 1', role: 'moderator', revision: '0' },
      { kind: 'token.governance.role.set', userId: 'acct-1', role: '', revision: '0' },
    ]) {
      expect(readDeskRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('says what each change does in plain words', () => {
    const settings = readDeskRequest({
      kind: 'token.governance.settings.set',
      votingDelayMs: '',
      votingPeriodMs: '172800000',
      revision: '2',
    })!;
    expect(describeRequest(settings)).toContain('voting delay to not set and the voting period to 2 days (48 hours)');
    const role = readDeskRequest({ kind: 'token.governance.role.set', userId: 'acct-1', role: 'moderator', revision: '0' })!;
    expect(describeRequest(role)).toContain('Give account acct-1 the governance role moderator');
  });
});

describe('governance figures', () => {
  it('turns form hours into stored milliseconds and refuses what svc-token refuses', () => {
    expect(hoursToMs('', 'delay')).toEqual({ ok: true, ms: null });
    expect(hoursToMs('0', 'delay')).toEqual({ ok: true, ms: '0' });
    expect(hoursToMs('24', 'period')).toEqual({ ok: true, ms: '86400000' });
    expect(hoursToMs('0', 'period').ok).toBe(false);
    expect(hoursToMs('8761', 'delay').ok).toBe(false);
    expect(hoursToMs('1.5', 'delay').ok).toBe(false);
    expect(msToHours('86400000')).toBe('24');
    expect(msToHours(null)).toBe('');
    expect(msToHours('1')).toBe('');
    expect(durationWords(null)).toBe('not set');
    expect(durationWords('0')).toBe('0 hours (no delay)');
    expect(durationWords('3600000')).toBe('1 hour');
    expect(durationWords('86400000')).toBe('1 day (24 hours)');
  });
});
