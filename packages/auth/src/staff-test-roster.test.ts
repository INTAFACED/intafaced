import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinStaffRoleForAssignment, BUILTIN_STAFF_ROLE_MAPPINGS, StaffPermissionError } from './staff-permissions.js';
import {
  STAFF_TEST_ROLE_NAMES,
  StaffTestRosterError,
  parseStaffTestRoster,
  scopesForStaffTestSession,
  staffRoleMappingsFor,
  staffTestRoleFor,
  type StaffTestRoleName,
} from './staff-test-roster.js';

// The roster the local and test stacks boot with: the labelled TEST value in the identity owner-values profile.
const profile = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../tooling/profiles/test-owner-values/identity.json', import.meta.url)), 'utf8'),
) as { values: Record<string, { value: string }> };
const STACK_ROSTER = profile.values.IDENTITY_STAFF_TEST_ROSTER!.value;

const role = (scopes: string[] = ['admin:read'], allow: string[] = ['staff:accounts:read:local']) => ({
  label: 'TEST role',
  sessionScopes: scopes,
  allow,
  deny: [],
});
const roster = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    label: 'TEST roster',
    roles: { support: role(), compliance: role(), risk: role(), finance: role() },
    members: [{ email: 'local-test-staff-support@local-test.invalid', role: 'support' }],
    ...patch,
  });

function refusal(fn: () => unknown): StaffTestRosterError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StaffTestRosterError) return error;
    throw error;
  }
  throw new Error('expected a StaffTestRosterError');
}

const PRODUCTION_LIKE = [undefined, '', ' ', 'production', 'prod', 'staging', 'DEV', 'Test', 'dev ', 'development'];

describe('production keeps the null mappings and admits no TEST role', () => {
  it('reads a blank roster as none on every APP_ENV', () => {
    for (const appEnv of [...PRODUCTION_LIKE, 'dev', 'test']) {
      expect(parseStaffTestRoster('', appEnv)).toBeUndefined();
      expect(parseStaffTestRoster(undefined, appEnv)).toBeUndefined();
    }
  });

  it('refuses each TEST role on a production-like APP_ENV', () => {
    // The planted fault: if this ever passes a roster through outside dev or test, production would admit a TEST role.
    for (const appEnv of PRODUCTION_LIKE) {
      const err = refusal(() => parseStaffTestRoster(STACK_ROSTER, appEnv));
      expect(err.code).toBe('identity.staff_test_roster_refused');
    }
  });

  it('with no roster, every built-in role still refuses identity.role_mapping_unset and nobody gets a TEST role', () => {
    const mappings = staffRoleMappingsFor(undefined);
    expect(mappings).toBe(BUILTIN_STAFF_ROLE_MAPPINGS);
    for (const name of ['support', 'compliance', 'finance'] as const) {
      expect(mappings[name]).toBeNull();
      const err = (() => {
        try {
          builtinStaffRoleForAssignment(name, mappings);
        } catch (error) {
          return error as StaffPermissionError;
        }
        throw new Error('expected a refusal');
      })();
      expect(err.code).toBe('identity.role_mapping_unset');
    }
    for (const name of STAFF_TEST_ROLE_NAMES) {
      const email = `local-test-staff-${name}@local-test.invalid`;
      expect(staffTestRoleFor(undefined, email)).toBeNull();
      expect(scopesForStaffTestSession(['trade:read'], { roster: undefined, role: name, mfa: true })).toEqual(['trade:read']);
    }
  });
});

describe('the test stack admits each TEST role', () => {
  const stack = parseStaffTestRoster(STACK_ROSTER, 'test')!;

  it('labels the roster and every role TEST', () => {
    expect(stack.label).toMatch(/^TEST\b/);
    for (const name of STAFF_TEST_ROLE_NAMES) expect(stack.roles[name].label).toMatch(/^TEST\b/);
    expect(parseStaffTestRoster(STACK_ROSTER, 'dev')).toEqual(stack);
  });

  it('has one member per role, each given its role and that role scopes on a second-factor session', () => {
    for (const name of STAFF_TEST_ROLE_NAMES) {
      const email = `local-test-staff-${name}@local-test.invalid`;
      expect(staffTestRoleFor(stack, email)).toBe(name);
      expect(staffTestRoleFor(stack, ` ${email.toUpperCase()} `)).toBe(name);
      const scopes = scopesForStaffTestSession(['trade:read'], { roster: stack, role: name, mfa: true });
      expect(scopes.length).toBeGreaterThan(1);
      expect(scopes).toEqual(['trade:read', ...stack.roles[name].sessionScopes]);
    }
    expect(staffTestRoleFor(stack, 'someone@example.com')).toBeNull();
  });

  it('fills the support, compliance and finance mappings and leaves founder and developer null', () => {
    const mappings = staffRoleMappingsFor(stack);
    for (const name of ['support', 'compliance', 'finance'] as const) {
      expect(builtinStaffRoleForAssignment(name, mappings).allow).toEqual(stack.roles[name].allow);
    }
    expect(mappings.founder).toBeNull();
    expect(mappings.developer).toBeNull();
  });

  it('gives no TEST scope without a second factor, on an API key or on a sub-account', () => {
    for (const name of STAFF_TEST_ROLE_NAMES) {
      expect(scopesForStaffTestSession([], { roster: stack, role: name, mfa: false })).toEqual([]);
      expect(scopesForStaffTestSession([], { roster: stack, role: name, mfa: true, apiKey: true })).toEqual([]);
      expect(scopesForStaffTestSession([], { roster: stack, role: name, mfa: true, subAccount: true })).toEqual([]);
    }
    expect(scopesForStaffTestSession([], { roster: stack, role: null, mfa: true })).toEqual([]);
  });

  it('never grants a money scope or a production permission', () => {
    for (const name of STAFF_TEST_ROLE_NAMES) {
      const r = stack.roles[name];
      expect(r.sessionScopes.some((s) => s === 'admin:treasury' || s.startsWith('pay:') || s === 'trade:withdraw')).toBe(false);
      expect([...r.allow, ...r.deny].some((p) => p.endsWith(':production'))).toBe(false);
    }
  });
});

describe('a roster that breaks a rule refuses', () => {
  const cases: Array<[string, string]> = [
    ['not JSON', '{'],
    ['no TEST label on the roster', roster({ label: 'Staff roster' })],
    [
      'no TEST label on a role',
      roster({ roles: { support: { ...role(), label: 'Support' }, compliance: role(), risk: role(), finance: role() } }),
    ],
    ['a missing role', roster({ roles: { support: role(), compliance: role(), risk: role() } })],
    ['an unknown role', roster({ roles: { support: role(), compliance: role(), risk: role(), finance: role(), founder: role() } })],
    ['a money scope', roster({ roles: { support: role(['admin:treasury']), compliance: role(), risk: role(), finance: role() } })],
    ['a pay scope', roster({ roles: { support: role(['pay:refund']), compliance: role(), risk: role(), finance: role() } })],
    [
      'a production permission',
      roster({
        roles: { support: role(['admin:read'], ['staff:ledger:read:production']), compliance: role(), risk: role(), finance: role() },
      }),
    ],
    [
      'a permission outside the catalogue',
      roster({ roles: { support: role(['admin:read'], ['staff:all']), compliance: role(), risk: role(), finance: role() } }),
    ],
    ['a real-looking member email', roster({ members: [{ email: 'alice@intafaced.com', role: 'support' }] })],
    [
      'a member listed twice',
      roster({
        members: [
          { email: 'a@local-test.invalid', role: 'support' },
          { email: 'a@local-test.invalid', role: 'risk' },
        ],
      }),
    ],
    ['a member with no TEST role', roster({ members: [{ email: 'a@local-test.invalid', role: 'founder' }] })],
    ['an unknown field', roster({ extra: true })],
  ];
  it.each(cases)('%s', (_name, raw) => {
    expect(refusal(() => parseStaffTestRoster(raw, 'test')).code).toBe('identity.staff_test_roster_invalid');
  });

  it('refuses outside a test stack before reading the value at all', () => {
    expect(refusal(() => parseStaffTestRoster('{', 'production')).code).toBe('identity.staff_test_roster_refused');
  });
});

describe('a hand-built roster cannot slip a scope past the allowlist', () => {
  it('drops a scope outside the founder allowlist at session time', () => {
    const stack = parseStaffTestRoster(roster(), 'test')!;
    const forged = { ...stack, roles: { ...stack.roles, support: { ...stack.roles.support, sessionScopes: ['admin:treasury' as never] } } };
    expect(scopesForStaffTestSession([], { roster: forged, role: 'support' as StaffTestRoleName, mfa: true })).toEqual([]);
  });
});
