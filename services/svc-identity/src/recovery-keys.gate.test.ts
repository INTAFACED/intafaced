import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { RecoveryPublicJwk } from '@intafaced/contracts/identity-recovery';
import { RecoveryKeys, refuseNonOwner } from './auth/recovery-keys.js';
import { principalWith, recordingSql } from './boot.testkit.js';
import { createRecoveryKeysRouter } from './recovery-keys-router.js';

/**
 * Staff are never a recovery voter (RC-identity-07, TRD-0764): the recovery doors take only the owner's own scopes, are
 * never public or service doors, and every one refuses a staff, API key or sub-account caller before it reads anything.
 * Asked through the real router and service over a recording stand-in for Postgres: a change that opens a recovery door
 * to staff, or lets a refused caller reach a query, fails here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const SUB = '77777777-7777-4777-8777-777777777777';

function publicKey(): RecoveryPublicJwk {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as RecoveryPublicJwk;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** The real service over a recording database; a step-up that no refused caller may reach. */
function service(founders: readonly string[] = []) {
  const db = recordingSql();
  const stepUp = {
    require: async () => {
      throw new Error('step-up must not be reached');
    },
  };
  return { keys: new RecoveryKeys(db.sql as never, stepUp as never, founders), queries: db.queries };
}

const ctx = (principal: Principal | null, caller: string | null = null): Context => ({
  principal,
  service: caller,
  region: 'DE',
  requestId: 'req-recovery',
});
const person = (scopes: readonly string[]) => principalWith(scopes, { userId: OWNER });
const apiKey = async (scopes: readonly string[]) => ({ ...(await person(scopes)), kid: 'key-1' }) as Principal;
const subAccount = async (scopes: readonly string[]) => ({ ...(await person(scopes)), sub_account: SUB }) as Principal;

const addInput = () => ({ kind: 'key' as const, label: 'laptop', publicKey: publicKey(), clientRequestId: 'add-1' });
const revokeInput = { keyId: KEY, clientRequestId: 'revoke-1' };
const planInput = { heirHandle: 'heir_one', threshold: 1, clientRequestId: 'plan-1' };

type Api = ReturnType<ReturnType<typeof createRecoveryKeysRouter>['createCaller']>;
const DOORS: ReadonlyArray<{ door: string; scope: string; call: (api: Api) => Promise<unknown> }> = [
  { door: 'recovery.keys.list', scope: 'identity:read', call: (api) => api.recovery.keys.list({}) },
  { door: 'recovery.keys.add', scope: 'identity:write', call: (api) => api.recovery.keys.add(addInput()) },
  { door: 'recovery.keys.revoke', scope: 'identity:write', call: (api) => api.recovery.keys.revoke(revokeInput) },
  { door: 'recovery.plan.set', scope: 'identity:write', call: (api) => api.recovery.plan.set(planInput) },
];
const STAFF = ['admin:compliance', 'admin:read', 'admin:write', 'support:ops', 'market:ops'];
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as { code?: string },
  );

describe('recovery doors gate (no staff scope reaches a recovery key)', () => {
  it('declares exactly the owner doors, with the owner scopes only', async () => {
    expect(Object.keys(createRecoveryKeysRouter(service().keys)._def.procedures).sort()).toEqual(DOORS.map((d) => d.door).sort());
    for (const { door, scope, call } of DOORS) {
      const { keys, queries } = service();
      const api = (c: Context) => createRecoveryKeysRouter(keys).createCaller(c);
      // Nobody, and a service with no person: not a public door, not a service door.
      expect(await failure(call(api(ctx(null)))), door).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await failure(call(api(ctx(null, 'svc-bank')))), door).toMatchObject({ code: 'UNAUTHORIZED' });
      // A person without the owner scope, and every staff scope without it: a scope miss.
      const other = scope === 'identity:read' ? 'identity:write' : 'identity:read';
      expect(await failure(call(api(ctx(await person([other]))))), door).toMatchObject({ code: 'FORBIDDEN' });
      expect(await failure(call(api(ctx(await person(STAFF))))), door).toMatchObject({ code: 'FORBIDDEN' });
      expect(queries, door).toEqual([]);
      // The owner scope alone reaches the service, which reads the owner's own account.
      await failure(call(api(ctx(await person([scope])))));
      expect(queries.length, door).toBeGreaterThan(0);
    }
  });

  it('every door refuses a non-owner first', async () => {
    const owned = ['identity:read', 'identity:write'];
    const callers: Array<[string, () => Promise<Principal>, string]> = [
      ['staff with the owner scopes', () => person([...owned, 'admin:compliance']), 'identity.recovery_staff_forbidden'],
      ['support with the owner scopes', () => person([...owned, 'support:ops']), 'identity.recovery_staff_forbidden'],
      ['an API key', () => apiKey(owned), 'identity.delegated_refused'],
      ['a sub-account', () => subAccount(owned), 'identity.delegated_refused'],
    ];
    for (const [who, principal, code] of callers) {
      const { keys, queries } = service();
      const p = await principal();
      // The service's own doors, called directly: refused with no query run.
      const doors: Array<[string, () => Promise<unknown>]> = [
        ['add', () => keys.add(p, addInput())],
        ['revoke', () => keys.revoke(p, revokeInput)],
        ['setPlan', () => keys.setPlan(p, planInput)],
        ['refuse', async () => keys.refuse(p)],
      ];
      for (const [door, run] of doors) expect(await failure(run()), `${who} ${door}`).toMatchObject({ code });
      expect(queries, who).toEqual([]);
      // Through the router, every door including list: refused, and still no query.
      const api = createRecoveryKeysRouter(keys).createCaller(ctx(p));
      for (const { door, call } of DOORS) expect(await failure(call(api)), `${who} ${door}`).toMatchObject({ code: 'FORBIDDEN' });
      expect(queries, who).toEqual([]);
    }
  });

  it('the refusal is the shared operator test, founders included, and every delegated caller', async () => {
    const owner = await person(['identity:read', 'identity:write']);
    expect(() => refuseNonOwner(owner)).not.toThrow();
    // A founder holds no staff scope here and is still the platform, never a recovery party.
    expect(() => refuseNonOwner(owner, [OWNER])).toThrow(expect.objectContaining({ code: 'identity.recovery_staff_forbidden' }));
    const { keys, queries } = service([OWNER]);
    expect(await failure(keys.add(owner, addInput()))).toMatchObject({ code: 'identity.recovery_staff_forbidden' });
    expect(queries).toEqual([]);
    for (const scope of ['admin:compliance', 'support:ops', 'market:ops']) {
      const staff = await person(['identity:write', scope]);
      expect(() => refuseNonOwner(staff), scope).toThrow(expect.objectContaining({ code: 'identity.recovery_staff_forbidden' }));
    }
    // A delegated caller is refused whatever it holds, a founder's key included.
    expect(() => refuseNonOwner({ ...owner, kid: 'k' } as Principal, [OWNER])).toThrow(
      expect.objectContaining({ code: 'identity.delegated_refused' }),
    );
    expect(() => refuseNonOwner({ ...owner, sub_account: SUB } as Principal)).toThrow(
      expect.objectContaining({ code: 'identity.delegated_refused' }),
    );
  });

  it('no key material is stored, only its fingerprint', () => {
    const migration = readFileSync(join(here, '../drizzle/20261024225038_recovery_keys.sql'), 'utf8');
    const table = migration.slice(migration.indexOf('"recovery_keys" ('));
    expect(table).toMatch(/"public_material_hash" text NOT NULL/);
    expect(table).not.toMatch(/private|secret|"x"|"y"|jwk|public_key"/i);
  });
});
