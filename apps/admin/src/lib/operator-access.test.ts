import { describe, expect, it } from 'vitest';
import { paletteEntries, searchPalette } from './command-palette';
import { MODULE_IDS } from './modules';
import { MODULE_STAFF_AREA, modulesFor, staffReadAreasOf } from './operator-access';

/** A compact JWT whose payload is `claims` (unsigned: the console reads its own session's token, it does not verify it). */
const token = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** The TEST support role's claim as identity mints it for `local` (tooling/profiles/test-owner-values/identity.json). */
const SUPPORT = token({
  staffEnv: 'local',
  staffPermissions: ['accounts:read', 'payments:read', 'trading:read', 'documents:read'],
});

describe('operator access: pages the person lacks scope for are not listed (OPS-admin-access-08)', () => {
  it('reads the read areas from the session token, for the TEST environment only', () => {
    expect(staffReadAreasOf(SUPPORT)).toEqual(['accounts', 'payments', 'trading', 'documents']);
    expect(staffReadAreasOf(token({ staffEnv: 'local', staffPermissions: ['ledger:update', 'ledger:read', 'ledger:read'] }))).toEqual([
      'ledger',
    ]);
    // Another environment, no claim, a malformed entry or a token that is not one: nothing at all, never a partial list.
    expect(staffReadAreasOf(token({ staffEnv: 'production', staffPermissions: ['accounts:read'] }))).toEqual([]);
    expect(staffReadAreasOf(token({ staffEnv: 'local' }))).toEqual([]);
    expect(staffReadAreasOf(token({ staffEnv: 'local', staffPermissions: ['accounts:read', 'moon:read'] }))).toEqual([]);
    expect(staffReadAreasOf(token({ staffEnv: 'local', staffPermissions: ['accounts:read:local'] }))).toEqual([]);
    expect(staffReadAreasOf(token({ staffEnv: 'local', staffPermissions: [7] }))).toEqual([]);
    expect(staffReadAreasOf('not-a-token')).toEqual([]);
    expect(staffReadAreasOf('a.%%%.c')).toEqual([]);
  });

  it('a founder holds every enabled module; staff hold only the modules of areas they may read', () => {
    expect(modulesFor({ kind: 'founder' }, MODULE_IDS)).toEqual([...MODULE_IDS]);
    expect(modulesFor({ kind: 'founder' }, ['crm'])).toEqual(['crm']);
    const support = modulesFor({ kind: 'staff', readAreas: staffReadAreasOf(SUPPORT) }, MODULE_IDS);
    expect(support).toContain('accounts');
    expect(support).toContain('crm');
    expect(support).not.toContain('ledger');
    expect(support).not.toContain('custody-ops');
    expect(modulesFor({ kind: 'staff', readAreas: [] }, MODULE_IDS)).toEqual([]);
    // A module the deployment switched off stays off for staff too.
    expect(modulesFor({ kind: 'staff', readAreas: ['accounts'] }, ['ledger'])).toEqual([]);
  });

  it('every module names a staff area', () => {
    for (const id of MODULE_IDS) expect(MODULE_STAFF_AREA[id], id).toBeTruthy();
  });

  it('the palette lists no ledger page or action to a person without ledger read, and lists them to a founder', () => {
    const forSupport = searchPalette(
      paletteEntries(modulesFor({ kind: 'staff', readAreas: staffReadAreasOf(SUPPORT) }, MODULE_IDS)),
      'ledger',
    );
    expect(forSupport.map((e) => e.label)).not.toContain('Ledger ops');
    expect(forSupport.map((e) => e.label)).not.toContain('Freeze or unfreeze ledger posting');
    expect(forSupport.every((e) => e.href === null || !e.href.startsWith('/ledger'))).toBe(true);
    const forFounder = searchPalette(paletteEntries(modulesFor({ kind: 'founder' }, MODULE_IDS)), 'ledger');
    expect(forFounder[0]?.label).toBe('Ledger ops');
    expect(forFounder.map((e) => e.label)).toContain('Freeze or unfreeze ledger posting');
  });
});
