import { randomBytes, webcrypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { recoveryKeyFingerprint, type RecoveryPublicJwk } from '@intafaced/contracts/identity-recovery';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createRecoveryKeysRouter } from '../recovery-keys-router.js';
import { AuthService } from './auth-service.js';
import { RecoveryKeys } from './recovery-keys.js';
import { SecurityStepUpError, type SecurityStepUp } from './security-step-up.js';

/**
 * Recovery keys (RC-identity-07, J-identity-05 #7): the owner adds and revokes keys and names a heir and threshold,
 * each with the step-up; staff, API keys and sub-accounts are refused. Every key here is a TEST fixture.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const available = await postgresAvailable(URL);

async function newKey(): Promise<RecoveryPublicJwk> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
}

if (!available) {
  describe.skip('recovery keys (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );

  /** The stand-in step-up: no approval asks for one; each approval is recorded with what it bound. */
  const stepUps: Array<{ scope: string; fields: Record<string, string> }> = [];
  const stepUp = {
    async require(
      principal: { kid?: string; sub_account?: string },
      scope: string,
      fields: Record<string, string>,
      approvalId?: string | null,
    ) {
      if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
      if (!approvalId) throw new SecurityStepUpError('identity.step_up_required');
      stepUps.push({ scope, fields });
    },
  } as unknown as SecurityStepUp;
  const FOUNDER = '00000000-0000-4000-8000-00000000f0f0';
  const recoveryRouter = createRecoveryKeysRouter(new RecoveryKeys(db.sql, stepUp, [FOUNDER]));
  const callerFor = (userId: string, extra: Record<string, unknown> = {}, scopes = ['identity:read', 'identity:write']) =>
    recoveryRouter.createCaller({
      principal: { userId, sid: 'sid-1', scopes, mfa: true, ...extra },
      service: null,
      region: 'DE',
      requestId: 'req-recovery',
    } as unknown as Context);
  const codeOf = async (p: Promise<unknown>) =>
    (
      (await p.then(
        () => null,
        (e: unknown) => e,
      )) as { cause?: { code?: string } } | null
    )?.cause?.code;

  let counter = 0;
  async function person() {
    const handle = `rk${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { userId: session.userId, handle, api: callerFor(session.userId) };
  }
  type Person = Awaited<ReturnType<typeof person>>;

  async function addKey(who: Person, label = 'Sister', publicKey?: RecoveryPublicJwk) {
    const key = publicKey ?? (await newKey());
    const input = { kind: 'key' as const, label, publicKey: key, clientRequestId: `add-${label}` };
    expect(await codeOf(who.api.recovery.keys.add(input))).toBe('identity.step_up_required');
    const view = await who.api.recovery.keys.add({ ...input, stepUpApprovalId: 'ok' });
    return { key, view };
  }

  beforeEach(async () => {
    stepUps.length = 0;
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('the owner sets recovery keys', () => {
    it('starts with nothing set and says what is missing', async () => {
      const owner = await person();
      expect(await owner.api.recovery.keys.list()).toEqual({
        heir: null,
        threshold: null,
        keys: [],
        activeKeys: 0,
        ready: false,
        missing: ['heir', 'threshold', 'keys'],
      });
    });

    it('adds a key with the step-up, stores only its fingerprint, and lists it', async () => {
      const owner = await person();
      const { key, view } = await addKey(owner);
      const fingerprint = await recoveryKeyFingerprint(key);
      expect(view.keys).toEqual([expect.objectContaining({ kind: 'key', label: 'Sister', fingerprint, revokedAt: null })]);
      expect(view.activeKeys).toBe(1);
      expect(stepUps).toEqual([
        { scope: 'identity.step_up.recovery_key_change', fields: { change: 'add', target: fingerprint, clientRequestId: 'add-Sister' } },
      ]);
      const rows = await db.sql`SELECT * FROM recovery_keys WHERE user_id = ${owner.userId}`;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(key.x);
      expect(JSON.stringify(rows)).not.toContain(key.y);
    });

    it('adding the same key again is one row and asks for no second confirmation', async () => {
      const owner = await person();
      const { key } = await addKey(owner);
      const again = await owner.api.recovery.keys.add({ kind: 'key', label: 'Other name', publicKey: key, clientRequestId: 'retry' });
      expect(again.keys).toHaveLength(1);
      expect(again.keys[0]!.label).toBe('Sister');
      expect(stepUps).toHaveLength(1);
    });

    it('refuses a point that is not on P-256 before any confirmation', async () => {
      const owner = await person();
      const key = await newKey();
      const bad = { ...key, y: key.x };
      expect(
        await codeOf(
          owner.api.recovery.keys.add({ kind: 'key', label: 'Bad', publicKey: bad, clientRequestId: 'b', stepUpApprovalId: 'ok' }),
        ),
      ).toBe('identity.recovery_key_invalid');
      expect(stepUps).toHaveLength(0);
    });

    it('another spelling of the same point is the same key: one row, and a revoked key stays revoked', async () => {
      const owner = await person();
      const { key, view } = await addKey(owner);
      // The last base64url character of a 32-byte coordinate carries 2 spare bits: flip them.
      const respell = (c: string) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last = alphabet.indexOf(c.at(-1)!);
        return c.slice(0, -1) + alphabet[last ^ 1]!;
      };
      const other = { ...key, x: respell(key.x) };
      const again = await owner.api.recovery.keys.add({ kind: 'key', label: 'Twin', publicKey: other, clientRequestId: 't' });
      expect(again.keys).toHaveLength(1);
      await owner.api.recovery.keys.revoke({ keyId: view.keys[0]!.id, clientRequestId: 'r', stepUpApprovalId: 'ok' });
      expect(
        await codeOf(
          owner.api.recovery.keys.add({ kind: 'key', label: 'Twin', publicKey: other, clientRequestId: 't2', stepUpApprovalId: 'ok' }),
        ),
      ).toBe('identity.recovery_key_revoked');
    });

    it('refuses the kinds that are not wired yet', async () => {
      const owner = await person();
      const publicKey = await newKey();
      for (const kind of ['passkey', 'guardian'] as const) {
        expect(
          await codeOf(owner.api.recovery.keys.add({ kind, label: 'K', publicKey, clientRequestId: kind, stepUpApprovalId: 'ok' })),
        ).toBe('identity.recovery_kind_not_wired');
      }
    });

    it('revokes a key with the step-up; it stops counting, a second revoke changes nothing, and it cannot come back', async () => {
      const owner = await person();
      const { key, view } = await addKey(owner);
      const keyId = view.keys[0]!.id;
      expect(await codeOf(owner.api.recovery.keys.revoke({ keyId, clientRequestId: 'rv' }))).toBe('identity.step_up_required');
      const revoked = await owner.api.recovery.keys.revoke({ keyId, clientRequestId: 'rv', stepUpApprovalId: 'ok' });
      expect(revoked.activeKeys).toBe(0);
      expect(revoked.keys[0]!.revokedAt).not.toBeNull();
      expect(stepUps.at(-1)).toEqual({
        scope: 'identity.step_up.recovery_key_change',
        fields: { change: 'revoke', target: keyId, clientRequestId: 'rv' },
      });
      const before = stepUps.length;
      expect((await owner.api.recovery.keys.revoke({ keyId, clientRequestId: 'rv2' })).activeKeys).toBe(0);
      expect(stepUps).toHaveLength(before);
      expect(
        await codeOf(
          owner.api.recovery.keys.add({ kind: 'key', label: 'Back', publicKey: key, clientRequestId: 'x', stepUpApprovalId: 'ok' }),
        ),
      ).toBe('identity.recovery_key_revoked');
    });

    it("refuses to revoke another account's key", async () => {
      const owner = await person();
      const other = await person();
      const { view } = await addKey(owner);
      expect(await codeOf(other.api.recovery.keys.revoke({ keyId: view.keys[0]!.id, clientRequestId: 'x', stepUpApprovalId: 'ok' }))).toBe(
        'identity.recovery_key_not_found',
      );
      expect((await owner.api.recovery.keys.list()).activeKeys).toBe(1);
    });
  });

  describe('the owner names a heir and a threshold', () => {
    it('sets them with the step-up, and the setup is ready', async () => {
      const owner = await person();
      const heir = await person();
      await addKey(owner, 'Sister');
      await addKey(owner, 'Friend');
      const input = { heirHandle: `@${heir.handle.toUpperCase()}`, threshold: 2, clientRequestId: 'plan' };
      expect(await codeOf(owner.api.recovery.plan.set(input))).toBe('identity.step_up_required');
      const view = await owner.api.recovery.plan.set({ ...input, stepUpApprovalId: 'ok' });
      expect(view).toMatchObject({ heir: { handle: heir.handle, active: true }, threshold: 2, activeKeys: 2, ready: true, missing: [] });
      expect(stepUps.at(-1)).toEqual({
        scope: 'identity.step_up.recovery_key_change',
        fields: { change: 'plan', target: `plan:${heir.handle}:2`, clientRequestId: 'plan' },
      });
    });

    it('the same heir and threshold again answers unchanged and asks for no second confirmation', async () => {
      const owner = await person();
      const heir = await person();
      await addKey(owner);
      await owner.api.recovery.plan.set({ heirHandle: heir.handle, threshold: 1, clientRequestId: 'p', stepUpApprovalId: 'ok' });
      const before = stepUps.length;
      const again = await owner.api.recovery.plan.set({ heirHandle: `@${heir.handle}`, threshold: 1, clientRequestId: 'p2' });
      expect(again).toMatchObject({ heir: { handle: heir.handle }, threshold: 1, ready: true });
      expect(stepUps).toHaveLength(before);
    });

    it('a heir whose account is frozen later leaves the setup not ready, naming the heir as missing', async () => {
      const owner = await person();
      const heir = await person();
      await addKey(owner);
      await owner.api.recovery.plan.set({ heirHandle: heir.handle, threshold: 1, clientRequestId: 'p', stepUpApprovalId: 'ok' });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${heir.userId}`;
      expect(await owner.api.recovery.keys.list()).toMatchObject({
        heir: { handle: heir.handle, active: false },
        ready: false,
        missing: ['heir'],
      });
    });

    it('refuses a threshold above the live keys before any confirmation', async () => {
      const owner = await person();
      const heir = await person();
      await addKey(owner);
      const before = stepUps.length;
      expect(
        await codeOf(owner.api.recovery.plan.set({ heirHandle: heir.handle, threshold: 2, clientRequestId: 'p', stepUpApprovalId: 'ok' })),
      ).toBe('identity.recovery_threshold_too_high');
      expect(stepUps).toHaveLength(before);
    });

    it('refuses an unknown, frozen or own handle', async () => {
      const owner = await person();
      const frozen = await person();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen.userId}`;
      await addKey(owner);
      for (const [heirHandle, code] of [
        ['nobody_here_1', 'identity.recovery_heir_unknown'],
        [frozen.handle, 'identity.recovery_heir_unknown'],
        ['not a handle', 'identity.recovery_heir_unknown'],
        [owner.handle, 'identity.recovery_heir_self'],
      ] as const) {
        expect(await codeOf(owner.api.recovery.plan.set({ heirHandle, threshold: 1, clientRequestId: 'p', stepUpApprovalId: 'ok' }))).toBe(
          code,
        );
      }
      expect((await owner.api.recovery.keys.list()).heir).toBeNull();
    });

    it('a revoked key below the threshold leaves the setup not ready', async () => {
      const owner = await person();
      const heir = await person();
      const { view } = await addKey(owner);
      await owner.api.recovery.plan.set({ heirHandle: heir.handle, threshold: 1, clientRequestId: 'p', stepUpApprovalId: 'ok' });
      const after = await owner.api.recovery.keys.revoke({ keyId: view.keys[0]!.id, clientRequestId: 'r', stepUpApprovalId: 'ok' });
      expect(after).toMatchObject({ ready: false, missing: ['keys'], threshold: 1 });
    });
  });

  describe('only the owner', () => {
    it('refuses every procedure to a staff session, whatever it also holds', async () => {
      const owner = await person();
      const publicKey = await newKey();
      for (const staff of [['admin:read'], ['admin:compliance'], ['support:ops'], ['market:ops']]) {
        const api = callerFor(owner.userId, {}, ['identity:read', 'identity:write', ...staff]);
        expect(await codeOf(api.recovery.keys.list())).toBe('identity.recovery_staff_forbidden');
        expect(
          await codeOf(api.recovery.keys.add({ kind: 'key', label: 'K', publicKey, clientRequestId: 'k', stepUpApprovalId: 'ok' })),
        ).toBe('identity.recovery_staff_forbidden');
        expect(
          await codeOf(
            api.recovery.keys.revoke({ keyId: '00000000-0000-4000-8000-000000000000', clientRequestId: 'k', stepUpApprovalId: 'ok' }),
          ),
        ).toBe('identity.recovery_staff_forbidden');
        expect(
          await codeOf(api.recovery.plan.set({ heirHandle: 'someone', threshold: 1, clientRequestId: 'k', stepUpApprovalId: 'ok' })),
        ).toBe('identity.recovery_staff_forbidden');
      }
      expect(stepUps).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM recovery_keys`).toHaveLength(0);
    });

    it('refuses a founder, even in a session with no staff scope', async () => {
      const api = callerFor(FOUNDER);
      expect(await codeOf(api.recovery.keys.list())).toBe('identity.recovery_staff_forbidden');
      expect(
        await codeOf(api.recovery.plan.set({ heirHandle: 'someone', threshold: 1, clientRequestId: 'k', stepUpApprovalId: 'ok' })),
      ).toBe('identity.recovery_staff_forbidden');
    });

    it('the security lock holds adding a key and naming the heir, never revoking a key', async () => {
      const owner = await person();
      const heir = await person();
      const { view } = await addKey(owner);
      await db.sql`
        INSERT INTO account_security_locks (user_id, set_by, set_by_user_id) VALUES (${owner.userId}, 'self', ${owner.userId})`;
      expect(
        await codeOf(
          owner.api.recovery.keys.add({ kind: 'key', label: 'K', publicKey: await newKey(), clientRequestId: 'k', stepUpApprovalId: 'ok' }),
        ),
      ).toBe('identity.security_locked');
      expect(
        await codeOf(owner.api.recovery.plan.set({ heirHandle: heir.handle, threshold: 1, clientRequestId: 'p', stepUpApprovalId: 'ok' })),
      ).toBe('identity.security_locked');
      const revoked = await owner.api.recovery.keys.revoke({ keyId: view.keys[0]!.id, clientRequestId: 'r', stepUpApprovalId: 'ok' });
      expect(revoked.activeKeys).toBe(0);
    });

    it('refuses an API key and a sub-account', async () => {
      const owner = await person();
      const publicKey = await newKey();
      for (const extra of [{ kid: 'key-1' }, { sub_account: 'sub-1' }]) {
        const api = callerFor(owner.userId, extra);
        expect(await codeOf(api.recovery.keys.list())).toBe('identity.delegated_refused');
        expect(
          await codeOf(api.recovery.keys.add({ kind: 'key', label: 'K', publicKey, clientRequestId: 'k', stepUpApprovalId: 'ok' })),
        ).toBe('identity.delegated_refused');
      }
      expect(await db.sql`SELECT 1 FROM recovery_keys`).toHaveLength(0);
    });

    it('refuses changes on a frozen account', async () => {
      const owner = await person();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${owner.userId}`;
      expect(
        await codeOf(
          owner.api.recovery.keys.add({ kind: 'key', label: 'K', publicKey: await newKey(), clientRequestId: 'k', stepUpApprovalId: 'ok' }),
        ),
      ).toBe('auth.account_frozen');
    });
  });
}
