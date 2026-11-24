import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HOUSE_INTERNAL_VENUE_DETAIL,
  SealedHouseTenantRegistry,
  adminKill,
  authorizeTenantVenue,
  isExternalVenueTarget,
  keyNamespaceFor,
  refuseInternalVenue,
  type HouseTenant,
} from './house-tenant.js';

function tenant(over: Partial<HouseTenant> = {}): HouseTenant {
  return {
    tenantId: 'house-1',
    keyNamespace: 'execution.tenant.house-1',
    killed: false,
    ...over,
  };
}

describe('key namespace', () => {
  it('scopes keys per tenant, never a shared house key', () => {
    expect(keyNamespaceFor('desk-a')).toBe('execution.tenant.desk-a');
    expect(keyNamespaceFor('desk-b')).toBe('execution.tenant.desk-b');
    expect(keyNamespaceFor('desk-a')).not.toBe(keyNamespaceFor('desk-b'));
  });
});

describe('isExternalVenueTarget', () => {
  it('treats internal and matching-book as non-external', () => {
    expect(isExternalVenueTarget({ kind: 'internal' })).toBe(false);
    expect(isExternalVenueTarget({ kind: 'matching-book' })).toBe(false);
    expect(isExternalVenueTarget({ kind: 'external', venueId: 'opaque-venue-id' })).toBe(true);
  });
});

describe('refuseInternalVenue — same vocabulary as refuseInternalMm', () => {
  it('always blocks with internal_venue', () => {
    const r = refuseInternalVenue();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('internal_venue');
    expect(r.detail).toMatch(/D26-P0-01/);
    expect(HOUSE_INTERNAL_VENUE_DETAIL).toMatch(/matching-book|matching book/i);
  });
});

describe('authorizeTenantVenue — kill first (ADR rule 5)', () => {
  it('allows an opaque external venue id without inventing a venue list', () => {
    const result = authorizeTenantVenue(tenant(), { kind: 'external', venueId: 'ext-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.venueId).toBe('ext-1');
    expect(result.keyNamespace).toBe('execution.tenant.house-1');
  });

  it('refuses kind internal', () => {
    const result = authorizeTenantVenue(tenant(), { kind: 'internal' });
    expect(result).toMatchObject({ ok: false, reason: 'internal_venue' });
    if (result.ok) return;
    expect(result.detail).toMatch(/D26-P0-01/);
  });

  it('refuses matching-book pointer', () => {
    const result = authorizeTenantVenue(tenant(), { kind: 'matching-book' });
    expect(result).toMatchObject({ ok: false, reason: 'internal_venue' });
  });

  it('kill_switch wins over internal_venue when both apply', () => {
    const result = authorizeTenantVenue(tenant({ killed: true }), { kind: 'internal' });
    expect(result).toMatchObject({ ok: false, reason: 'kill_switch' });
  });

  it('killed tenant cannot quote or route even externally', () => {
    const result = authorizeTenantVenue(tenant({ killed: true }), { kind: 'external', venueId: 'ext-1' });
    expect(result).toMatchObject({ ok: false, reason: 'kill_switch' });
  });

  it('adminKill flips killed so subsequent authorize refuses', () => {
    const t = tenant();
    const audit = adminKill(t, 'ops-1', '2026-08-16T00:00:00.000Z');
    expect(t.killed).toBe(true);
    expect(audit.op).toBe('admin_kill');
    expect(authorizeTenantVenue(t, { kind: 'external', venueId: 'ext-1' }).ok).toBe(false);
  });
});

describe('SealedHouseTenantRegistry', () => {
  it('registers a sealed tenant, describes it, and records audit', () => {
    const clock = { n: 0 };
    const reg = new SealedHouseTenantRegistry(() => `t-${++clock.n}`);
    const created = reg.register('house-1', 'ops');
    expect(created).toMatchObject({
      tenantId: 'house-1',
      keyNamespace: 'execution.tenant.house-1',
      killed: false,
    });
    expect(reg.describe('house-1')).toMatchObject({
      tenantId: 'house-1',
      killed: false,
      auditCount: 1,
    });
    const firstAudit = reg.auditFor('house-1')[0];
    expect(firstAudit?.op).toBe('register');
  });

  it('kill then authorize external refuses kill_switch first', () => {
    const reg = new SealedHouseTenantRegistry(() => 't');
    reg.register('house-1', 'ops');
    const killed = reg.kill('house-1', 'admin');
    expect('ok' in killed ? true : killed.outcome).toBe('ok');
    const auth = reg.authorize('house-1', { kind: 'external', venueId: 'street-a' }, 'bot');
    expect(auth).toMatchObject({ ok: false, reason: 'kill_switch' });
  });

  it('does not expose strategies or alpha on describe', () => {
    const reg = new SealedHouseTenantRegistry(() => 't');
    reg.register('house-1', 'ops');
    const d = reg.describe('house-1');
    expect(d).not.toHaveProperty('strategy');
    expect(d).not.toHaveProperty('alpha');
    expect(JSON.stringify(d)).not.toMatch(/strategy|alpha/i);
  });
});

describe('matching package unimported', () => {
  it('does not import svc-matching or a matching workspace package', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8')) as Partial<
      Record<'dependencies' | 'devDependencies' | 'peerDependencies', Record<string, string>>
    >;
    const deps = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap((d) => Object.keys(d ?? {}));
    // A workspace package resolves only when it is declared here, and a path into services/svc-matching is a B-hops
    // finding of tooling/ci/boundary-scan.mjs, so no matching import can land without failing one of the two.
    expect(deps.some((d) => /matching/i.test(d))).toBe(false);
  });
});
