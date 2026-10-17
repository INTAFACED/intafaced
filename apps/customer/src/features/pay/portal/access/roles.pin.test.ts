import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ROLE_CAPABILITIES } from './capabilities';

/**
 * `capabilities.ts` copies the service's role table for the moment `merchant.myAccess` is not live. If the table on
 * main changes and the copy does not, a team member would see a page they cannot use, or lose one they can. This
 * pins the copy to the source file in the same repository.
 */
const source = fileURLToPath(new URL('../../../../../../../services/svc-pay/src/merchant-ops/roles.ts', import.meta.url));
const roles = ['owner', 'admin', 'finance', 'developer', 'viewer'] as const;

describe.skipIf(!existsSync(source))('the copied role table matches services/svc-pay/src/merchant-ops/roles.ts', () => {
  it('holds the same permissions for every role', async () => {
    const real = (await import(/* @vite-ignore */ source)) as {
      MERCHANT_PERMISSIONS: readonly string[];
      roleHasPermission: (role: string, permission: string) => boolean;
    };
    // Every permission on main is one we know about.
    for (const permission of real.MERCHANT_PERMISSIONS) expect(CAPABILITIES as readonly string[], permission).toContain(permission);
    for (const role of roles)
      for (const permission of real.MERCHANT_PERMISSIONS)
        expect(ROLE_CAPABILITIES[role].has(permission as never), `${role} ${permission}`).toBe(real.roleHasPermission(role, permission));
  });
  it('holds no permission that main does not have, apart from the profile ones that are not on main yet', async () => {
    const real = (await import(/* @vite-ignore */ source)) as { MERCHANT_PERMISSIONS: readonly string[] };
    for (const role of roles)
      for (const held of ROLE_CAPABILITIES[role]) expect(real.MERCHANT_PERMISSIONS, `${role} ${held}`).toContain(held);
  });
});
