import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_RECOVERY_KEYS_LIST,
  IDENTITY_RECOVERY_KEYS_REVOKE,
  IDENTITY_RECOVERY_PLAN_SET,
} from '@intafaced/contracts/identity-recovery-procedures';

/**
 * Staff are never a recovery voter (RC-identity-07, TRD-0764): the recovery doors take only the owner's own scopes, are
 * never public or service doors, and every one refuses a staff, API key or sub-account caller before it reads anything.
 * In the style of `kyc/pii-isolation.gate.test.ts`: a change that opens a recovery door to staff fails here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const routerSrc = readFileSync(join(here, 'recovery-keys-router.ts'), 'utf8');
const serviceSrc = readFileSync(join(here, 'auth/recovery-keys.ts'), 'utf8');

// The records the router mounts, by the name it imports them under: a door mounted from one takes the record's access.
const RECORDS: Record<string, { access: unknown }> = {
  IDENTITY_RECOVERY_KEYS_LIST,
  IDENTITY_RECOVERY_KEYS_REVOKE,
  IDENTITY_RECOVERY_PLAN_SET,
};

function accessText(access: unknown): string {
  const a = access as { caller: string; scope?: string };
  return a.caller === 'scope' ? `scope('${a.scope}')` : a.caller;
}

/** Each door the router declares, in source order: a hand-written procedure as written, or a record's own access. */
function doors(src: string): string[] {
  return [
    ...src.matchAll(
      /(\w+): (?:(scopedProcedure|anyScopeProcedure|publicProcedure|protectedProcedure|serviceProcedure)\(([^)]*)\)|mountRecord\(\s*(\w+),)/g,
    ),
  ].map((m) => {
    if (m[2]) return `${m[1]} ${m[2] === 'scopedProcedure' ? `scope(${m[3]})` : `${m[2]}(${m[3]})`}`;
    const record = RECORDS[m[4]!];
    expect(record, `${m[4]} is a record this gate reads`).toBeDefined();
    return `${m[1]} ${accessText(record!.access)}`;
  });
}

describe('recovery doors gate (no staff scope reaches a recovery key)', () => {
  it('declares exactly the owner doors, with the owner scopes only', () => {
    expect(doors(routerSrc)).toEqual([
      "list scope('identity:read')",
      "add scope('identity:write')",
      "revoke scope('identity:write')",
      "set scope('identity:write')",
    ]);
    expect(routerSrc).not.toMatch(/admin:|support:ops|market:ops|serviceProcedure|publicProcedure/);
  });

  it('every door refuses a non-owner first', () => {
    // `list` calls the refusal itself; add, revoke and set start with it in the service.
    expect(routerSrc).toMatch(/keys\.refuse\(ctx\.principal\);\s*return await keys\.view/);
    for (const method of ['add', 'revoke', 'setPlan']) {
      const at = serviceSrc.indexOf(`async ${method}(`);
      expect(at, method).toBeGreaterThan(0);
      const body = serviceSrc.slice(at, serviceSrc.indexOf('\n  }\n', at));
      expect(body.indexOf('this.refuse(principal);'), method).toBeGreaterThan(0);
      expect(body.indexOf('this.refuse(principal);'), method).toBeLessThan(body.indexOf('this.sql'));
    }
  });

  it('the refusal is the shared operator test, founders included, and every delegated caller', () => {
    expect(serviceSrc).toMatch(
      /if \(isOperatorPrincipal\(\{ userId, mfa, scopes \}, founders\)\) throw new RecoveryKeyError\('identity\.recovery_staff_forbidden'\)/,
    );
    expect(serviceSrc).toMatch(/if \(principal\.kid \|\| principal\.sub_account\) throw/);
    expect(serviceSrc).toMatch(/refuse\(principal: RecoveryPrincipal\): void \{\s*refuseNonOwner\(principal, this\.founders\);/);
  });

  it('no key material is stored, only its fingerprint', () => {
    const migration = readFileSync(join(here, '../drizzle/20261024225038_recovery_keys.sql'), 'utf8');
    const table = migration.slice(migration.indexOf('"recovery_keys" ('));
    expect(table).toMatch(/"public_material_hash" text NOT NULL/);
    expect(table).not.toMatch(/private|secret|"x"|"y"|jwk|public_key"/i);
  });
});
