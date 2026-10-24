import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECOVERY_CLAIM_VERIFIERS } from './auth/recovery-claim-verify.js';

/**
 * Death notices and the claim check (RC-identity-02, RC-identity-08). Staff decide that an owner died, never who receives
 * or which keys count: the notice doors are compliance doors only, recording one never touches the account, a freeze
 * only follows a spent second-person approval, and the claim check is a service door for svc-bank alone that reads the
 * owner's own keys and plan. A change that lets one person freeze an account, or staff answer a claim, fails here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const routerSrc = readFileSync(join(here, 'death-notices-router.ts'), 'utf8');
const serviceSrc = readFileSync(join(here, 'auth/death-notices.ts'), 'utf8');

function doors(src: string): string[] {
  return [
    ...src.matchAll(/(\w+): (scopedProcedure|anyScopeProcedure|publicProcedure|protectedProcedure|serviceProcedure)\(([^)]*)\)/g),
  ].map((m) => `${m[1]} ${m[2]}(${m[3]})`);
}

function body(name: string): string {
  const at = serviceSrc.indexOf(`export async function ${name}(`);
  expect(at, name).toBeGreaterThan(0);
  return serviceSrc.slice(at, serviceSrc.indexOf('\n}\n', at));
}

describe('death notice gate (one person never freezes an account; staff never answer a claim)', () => {
  it('declares exactly the compliance doors', () => {
    expect(doors(routerSrc)).toEqual([
      "record scopedProcedure('admin:compliance')",
      "forAccount scopedProcedure('admin:compliance')",
      "reject scopedProcedure('admin:compliance')",
      "confirm scopedProcedure('admin:compliance')",
    ]);
  });

  it('recording and rejecting never touch the account', () => {
    for (const name of ['recordDeathNotice', 'rejectDeathNotice']) {
      expect(body(name), name).not.toMatch(/UPDATE (users|sessions|api_keys|sub_accounts)/);
    }
  });

  it('confirming freezes only after a second person’s approval is spent', () => {
    const confirm = body('confirmDeathNotice');
    const spent = confirm.indexOf('await sqlCasConsume(');
    expect(spent).toBeGreaterThan(0);
    expect(confirm).toMatch(/approver !== requester &&/);
    expect(confirm).toMatch(/requester === actor\.userId &&/);
    for (const write of ["UPDATE users SET status = 'frozen'", 'UPDATE sessions SET revoked', 'UPDATE api_keys SET revoked']) {
      expect(confirm.indexOf(write), write).toBeGreaterThan(spent);
    }
  });

  it('the claim check is svc-bank’s alone and reads only the owner’s own keys and plan', () => {
    expect([...RECOVERY_CLAIM_VERIFIERS]).toEqual(['svc-bank']);
    const verify = body('verifyRecoveryClaim');
    expect(verify).toMatch(/FROM recovery_keys WHERE user_id = \$\{userId\}/);
    expect(verify).toMatch(/FROM recovery_plans p LEFT JOIN users h ON h\.id = p\.heir_user_id WHERE p\.user_id = \$\{userId\}/);
    expect(verify).not.toMatch(/scopes|principal|admin:/);
  });
});
