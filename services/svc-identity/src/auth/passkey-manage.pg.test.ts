/**
 * Passkey list, rename, kind and per-account limit, against Postgres (I-signin-sessions-09).
 * Limits below are TEST fixtures; the product ships with none stated.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { enrollPasskey, passkeyKind, toRegistrationResponseJSON, type PasskeyCeremony } from './enroll-passkey.js';
import { listPasskeys, normalizePasskeyLabel, renamePasskey, requireEnrolledSecondFactor } from './passkey-manage.js';
import { SecurityStepUp, SecurityStepUpError } from './security-step-up.js';
import type { ChallengeStorePort } from './webauthn.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));

describe('passkey kind and label', () => {
  it('derives kind only from what the authenticator reported', () => {
    expect(passkeyKind(['internal'])).toBe('platform');
    expect(passkeyKind(['hybrid', 'internal'])).toBe('cross_device');
    expect(passkeyKind(['usb', 'nfc'])).toBe('security_key');
    expect(passkeyKind(undefined)).toBe('unknown');
    expect(passkeyKind(['smart-card'])).toBe('unknown');
  });

  it('trims, and refuses empty, 65 characters and control characters', () => {
    expect(normalizePasskeyLabel('  Work laptop ')).toBe('Work laptop');
    expect(normalizePasskeyLabel('a'.repeat(64))).toHaveLength(64);
    for (const bad of ['', '   ', 'a'.repeat(65), 'tab\there', 'line\nbreak']) {
      expect(() => normalizePasskeyLabel(bad)).toThrow(/passkey_label_invalid/);
    }
  });
});

const available = await postgresAvailable(url);
if (!available) {
  describe.skip('passkey management (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  afterAll(async () => {
    await db.drop();
  });

  const cred = (id: string, extra: Record<string, unknown> = {}) => ({
    credentialId: id,
    publicKey: 'AQID',
    counter: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  });
  async function seed(creds: unknown[], opts: { status?: string; totp?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const handle = `p${id.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, status, totp_secret, totp_enrolled_at, webauthn_creds)
      VALUES (${id}, ${handle}, ${`${handle}@example.com`}, ${'x'}, ${opts.status ?? 'active'}, ${opts.totp ? 'verified-test-factor' : null}, ${opts.totp ? new Date() : null}, ${db.sql.json(creds as never)})`;
    return id;
  }

  describe('passkey management', () => {
    it('lists label, kind, created and last used, newest first, and honours the page size', async () => {
      const user = await seed([
        cred('old', { transports: ['usb'], createdAt: '2026-09-01T00:00:00.000Z' }),
        cred('new', { transports: ['internal'], label: 'Phone', lastVerifiedAt: '2026-10-10T00:00:00.000Z' }),
      ]);
      const rows = await listPasskeys(db.sql, user, 10);
      expect(rows.map((r) => r.credentialId)).toEqual(['new', 'old']);
      expect(rows[0]).toMatchObject({ label: 'Phone', kind: 'platform', lastUsedAt: '2026-10-10T00:00:00.000Z' });
      expect(rows[1]).toMatchObject({ label: null, kind: 'security_key', lastUsedAt: null });
      expect(await listPasskeys(db.sql, user, 1)).toHaveLength(1);
    });

    it('renames, is idempotent, keeps other fields, and loses to a removal', async () => {
      const user = await seed([cred('a', { transports: ['internal'] }), cred('b')]);
      const first = await renamePasskey(db.sql, user, 'a', ' Laptop ');
      expect(first).toMatchObject({ credentialId: 'a', label: 'Laptop', kind: 'platform' });
      await renamePasskey(db.sql, user, 'a', 'Laptop');
      const [stored] = await db.sql<Array<{ webauthn_creds: Array<Record<string, unknown>> }>>`
        SELECT webauthn_creds FROM users WHERE id = ${user}`;
      const webauthn_creds = stored!.webauthn_creds;
      expect(webauthn_creds.find((c) => c.credentialId === 'a')).toMatchObject({ label: 'Laptop', counter: 1, publicKey: 'AQID' });
      expect(webauthn_creds.find((c) => c.credentialId === 'b')?.label).toBeUndefined();
      await expect(renamePasskey(db.sql, user, 'gone', 'x')).rejects.toMatchObject({ code: 'auth.not_found' });
      await db.sql`UPDATE users SET webauthn_creds = '[]'::jsonb WHERE id = ${user}`;
      await expect(renamePasskey(db.sql, user, 'a', 'again')).rejects.toMatchObject({ code: 'auth.not_found' });
    });

    it('refuses a rename on a frozen account', async () => {
      const user = await seed([cred('a')], { status: 'frozen' });
      await expect(renamePasskey(db.sql, user, 'a', 'x')).rejects.toMatchObject({ code: 'auth.account_frozen' });
    });

    it('the step-up guard: no approval refused, approval spent once, no second factor offered enrolment', async () => {
      const spent = new Set<string>();
      const stepUp = new SecurityStepUp({
        sql: db.sql,
        approvals: {
          async consume(_s, input) {
            if (!input.approvalId.startsWith('ok') || spent.has(input.approvalId)) {
              const { ActionApprovalError } = await import('./action-approval-service.js');
              throw new ActionApprovalError('no', 'action_approval.not_found');
            }
            spent.add(input.approvalId);
          },
          async check() {
            throw new Error('not used by passkey management');
          },
        },
        secondFactor: requireEnrolledSecondFactor(db.sql),
      });
      const user = await seed([cred('a')]);
      const principal = { userId: user, sid: randomUUID() };
      const fields = { credentialId: 'a', label: 'L', clientRequestId: 'req-1' };
      await expect(stepUp.require(principal, 'identity.step_up.passkey_rename', fields, null)).rejects.toMatchObject({
        code: 'identity.step_up_required',
      });
      await expect(stepUp.require(principal, 'identity.step_up.passkey_rename', fields, 'ok1')).resolves.toBeUndefined();
      await expect(stepUp.require(principal, 'identity.step_up.passkey_rename', fields, 'ok1')).rejects.toBeInstanceOf(SecurityStepUpError);
      const bare = await seed([]);
      await expect(
        stepUp.require({ userId: bare, sid: randomUUID() }, 'identity.step_up.passkey_rename', fields, 'ok2'),
      ).rejects.toMatchObject({
        code: 'identity.second_factor_required',
      });
      const withTotp = await seed([], { totp: true });
      await expect(
        stepUp.require({ userId: withTotp, sid: randomUUID() }, 'identity.step_up.passkey_rename', fields, 'ok3'),
      ).resolves.toBeUndefined();
    });

    it('enrol stores the kind; a set limit refuses the extra passkey, an unset limit refuses nothing', async () => {
      const rp = { rpId: 'intafaced.com', origin: 'https://app.intafaced.com' };
      const ceremonyFor = (id: string): PasskeyCeremony => ({
        generate: (async () => ({ challenge: 'c' })) as never,
        verify: (async () => ({
          verified: true,
          registrationInfo: { credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['hybrid'] } },
        })) as never,
      });
      const challenges = (userId: string): ChallengeStorePort => ({
        async put() {},
        async take(challenge, kind) {
          return { challenge, userId, kind: kind as 'registration', expiresAt: Date.now() + 60_000 };
        },
      });
      const body = (id: string) =>
        toRegistrationResponseJSON({
          id,
          rawId: id,
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'c', origin: rp.origin })).toString(
              'base64url',
            ),
            attestationObject: 'a',
          },
        });
      const actor = { mfa: true, privileged: false };
      const user = await seed([], { totp: true });
      await enrollPasskey(db.sql, user, rp, body('p1'), challenges(user), actor, ceremonyFor('p1'), { maxPerAccount: 2 });
      await enrollPasskey(db.sql, user, rp, body('p2'), challenges(user), actor, ceremonyFor('p2'), { maxPerAccount: 2 });
      await expect(
        enrollPasskey(db.sql, user, rp, body('p3'), challenges(user), actor, ceremonyFor('p3'), { maxPerAccount: 2 }),
      ).rejects.toMatchObject({
        code: 'identity.passkey_limit',
      });
      const rows = await listPasskeys(db.sql, user, 10);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.kind).toBe('cross_device');
      await enrollPasskey(db.sql, user, rp, body('p3'), challenges(user), actor, ceremonyFor('p3'), {});
      expect(await listPasskeys(db.sql, user, 10)).toHaveLength(3);
      // Each passkey added queued its factor-changed notice (I-signin-sessions-08); the refused third queued none.
      const changes = await db.sql<Array<{ change: string }>>`SELECT change FROM security_factor_events WHERE user_id = ${user}`;
      expect(changes.map((c) => c.change)).toEqual(['passkey_added', 'passkey_added', 'passkey_added']);
    });
  });
}
