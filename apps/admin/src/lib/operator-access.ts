import { staffAreaSchema } from '@intafaced/contracts/identity-staff';
import type { ModuleId } from './modules';

/**
 * Who is using the console, and so which of its modules they are shown (OPS-admin-access-08: pages the person lacks scope
 * for are not listed). A founder holds every module. A TEST staff member (local and test stacks only, admitted by
 * `assertCurrentFounder` through identity's labelled TEST roster) holds the modules whose staff area their session may read.
 *
 * The areas come from the `staffPermissions` claim identity minted into the session's own access token (`<area>:<verb>` for
 * one environment, `staffEnv`). The console got that token from identity itself and keeps it only in its sealed cookie, so
 * reading its payload here is reading identity's answer; the claim gates what is listed, and every service still checks the
 * token's scopes on each call (`@intafaced/auth` staff-permissions: "the claim may gate reads and screens").
 *
 * Nothing here is money. This file stays free of Node-only and Next-only imports so the nav, the palette and tests share it.
 */

export type StaffArea = (typeof staffAreaSchema.options)[number];

export type OperatorAccess = { readonly kind: 'founder' } | { readonly kind: 'staff'; readonly readAreas: readonly StaffArea[] };

/** The environment identity mints a TEST staff session's permissions for (`@intafaced/auth` STAFF_TEST_ENV). */
export const STAFF_TEST_ENV = 'local' as const;

/**
 * The staff area a module belongs to: a staff member sees the module when their session may read that area. Every module
 * names one area, so a new module cannot be shown to staff by omission (the type requires it).
 */
export const MODULE_STAFF_AREA: Readonly<Record<ModuleId, StaffArea>> = {
  crm: 'accounts',
  accounts: 'accounts',
  support: 'accounts',
  killswitches: 'flags',
  launch: 'settings',
  jurisdiction: 'settings',
  tools: 'settings',
  notify: 'settings',
  'academy-ops': 'settings',
  'more-ops': 'settings',
  ledger: 'ledger',
  'custody-ops': 'ledger',
  merchants: 'payments',
  'bank-ops': 'payments',
  'pay-ops': 'payments',
  'p2p-ops': 'trading',
  'protocol-ops': 'trading',
  tradeops: 'trading',
  'identity-ops': 'authentication',
};

const AREAS: ReadonlySet<string> = new Set(staffAreaSchema.options);

/** The JSON payload of a compact JWT, unverified, or null when it is not one. */
function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The staff areas a session's access token may read in the TEST environment. A token with no claim, a claim for another
 * environment, or any entry outside the closed `<area>:<verb>` catalogue reads nothing at all (never a partial list).
 */
export function staffReadAreasOf(accessToken: string): StaffArea[] {
  const claims = payloadOf(accessToken);
  if (!claims || claims.staffEnv !== STAFF_TEST_ENV || !Array.isArray(claims.staffPermissions)) return [];
  const entries = claims.staffPermissions;
  const read: StaffArea[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') return [];
    const [area, verb, ...rest] = entry.split(':');
    if (rest.length > 0 || area === undefined || verb === undefined || !AREAS.has(area)) return [];
    if (verb === 'read' && !read.includes(area as StaffArea)) read.push(area as StaffArea);
  }
  return read;
}

/** The modules this person is shown, of those the deployment enables, in the order given. */
export function modulesFor(access: OperatorAccess, enabled: readonly ModuleId[]): ModuleId[] {
  if (access.kind === 'founder') return [...enabled];
  return enabled.filter((id) => access.readAreas.includes(MODULE_STAFF_AREA[id]));
}
