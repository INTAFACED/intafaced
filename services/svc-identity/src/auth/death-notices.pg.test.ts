/**
 * Death notices and the recovery claim check against Postgres (RC-identity-02, RC-identity-08; J-identity-05 #7). Staff
 * record a notice, which changes nothing; a second person's approval confirms it, which freezes the account; the relay
 * publishes both, at least once; and the claim check answers yes only for enough live keys the owner set, signing this
 * claim for the heir the owner named.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { recoveryClaimMessage, type RecoveryPublicJwk } from '@intafaced/contracts/identity-recovery';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import {
  confirmDeathNotice,
  deathNoticePayloadHash,
  listDeathNotices,
  recordDeathNotice,
  rejectDeathNotice,
  relayDeathNoticeEvents,
  verifyRecoveryClaim,
  type DeathNoticeDeps,
} from './death-notices.js';
import { fingerprintOf } from './recovery-keys.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const tokenConfig = {
  secret: 'an-identity-death-notice-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('death notices (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(
    db.sql,
    bus,
    new RankService(db.sql, bus),
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );
  auth.useLogger({ warn: () => undefined });
  const deps: DeathNoticeDeps = { sql: db.sql, now: () => new Date() };

  let n = 0;
  /** A TEST account with one live session and one API key. */
  async function customer() {
    const handle = `dn${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    await db.sql`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
      VALUES (${session.userId}, 'TEST bot', ${randomBytes(32).toString('hex')}, ${`k${n}`}, ${['identity:read']})`;
    return { userId: session.userId, handle };
  }
  /** An operator: a live session with its second factor, and a token with the scopes asked for. */
  async function operator(scopes: string[] = ['admin:compliance'], mfa = true) {
    const handle = `dop${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    await db.sql`UPDATE sessions SET mfa = ${mfa} WHERE id = ${session.sessionId}`;
    const { token } = await issueAccessToken(
      { userId: session.userId, sessionId: session.sessionId, scopes, tier: 'none', mfa },
      tokenConfig,
    );
    const context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'dn' } as Context;
    return { userId: session.userId, sessionId: session.sessionId, context };
  }
  async function approval(opts: { userId: string; noticeId: string; requester: string; approver: string | null; hash?: string }) {
    const approvalId = `apr-${randomUUID()}`;
    await db.sql`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at
      ) VALUES (
        ${approvalId}, 'identity.death_notice_confirm', 'svc-identity', ${opts.userId}, '1',
        ${opts.hash ?? deathNoticePayloadHash(opts.userId, opts.noticeId)}, ${opts.requester}, ${opts.approver}, '1', ${randomUUID()},
        ${opts.approver ? 'APPROVED' : 'PENDING'}, now(), now() + interval '1 hour', ${opts.approver ? new Date() : null}
      )`;
    return approvalId;
  }
  const approvalStatus = async (approvalId: string) =>
    (await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`)[0]!.status;
  const account = async (userId: string) =>
    (
      await db.sql<Array<{ status: string; live: number; keys: number }>>`
        SELECT u.status,
          (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked = false) AS live,
          (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked = false) AS keys
        FROM users u WHERE u.id = ${userId}`
    )[0]!;
  const record = (context: Context, userId: string, caseRef = 'CASE-1', over: { reporterKind?: 'executor' | 'family' } = {}) =>
    recordDeathNotice(deps, context, {
      userId,
      caseRef,
      reporterKind: over.reporterKind ?? 'executor',
      evidenceDocumentIds: [],
      receivedAt: new Date().toISOString(),
    });
  /** Records a notice for a new customer and confirms it with a second person's approval. */
  async function confirmed() {
    const who = await customer();
    const agent = await operator();
    const second = await operator();
    const notice = await record(agent.context, who.userId);
    const approvalId = await approval({ userId: who.userId, noticeId: notice.noticeId, requester: agent.userId, approver: second.userId });
    const view = await confirmDeathNotice(deps, agent.context, { noticeId: notice.noticeId, approvalId });
    return { who, agent, second, notice: view, approvalId };
  }

  describe('death notices (RC-identity-02)', () => {
    it('recording a notice changes nothing on the account, and the same case reference is one notice', async () => {
      const who = await customer();
      const agent = await operator();
      const before = await account(who.userId);
      const notice = await record(agent.context, who.userId);
      expect(notice).toMatchObject({
        userId: who.userId,
        caseRef: 'CASE-1',
        status: 'received',
        recordedBy: agent.userId,
        approvedBy: null,
      });
      expect(notice.approvalProposal).toEqual({
        actionType: 'identity.death_notice_confirm',
        targetService: 'svc-identity',
        targetId: who.userId,
        expectedVersion: '1',
        payloadHash: deathNoticePayloadHash(who.userId, notice.noticeId),
      });
      expect(await account(who.userId)).toEqual(before);
      expect(before).toMatchObject({ status: 'active', live: 1, keys: 1 });

      const again = await record((await operator()).context, who.userId);
      expect(again.noticeId).toBe(notice.noticeId);
      await expect(record(agent.context, who.userId, 'CASE-1', { reporterKind: 'family' })).rejects.toMatchObject({
        code: 'identity.death_notice_case_reused',
      });
      expect(await listDeathNotices(deps, agent.context, who.userId)).toHaveLength(1);
    });

    it('only staff with admin:compliance and a second factor on a live session record, never for their own account', async () => {
      const who = await customer();
      await expect(record((await operator(['admin:write'])).context, who.userId)).rejects.toMatchObject({ code: 'operator.denied' });
      await expect(record((await operator(['admin:compliance'], false)).context, who.userId)).rejects.toMatchObject({
        code: 'mfa.required',
      });
      const agent = await operator();
      await expect(record(agent.context, agent.userId)).rejects.toMatchObject({ code: 'identity.death_notice_self' });
      await expect(record(agent.context, randomUUID())).rejects.toMatchObject({ code: 'identity.death_notice_not_found' });
      // An API key or a service is not a person at the keyboard.
      const keyed = { ...agent.context, principal: { ...agent.context.principal!, kid: 'k-1' } } as Context;
      await expect(record(keyed, who.userId)).rejects.toMatchObject({ code: 'operator.denied' });
      await expect(record({ ...agent.context, service: 'svc-ops' } as Context, who.userId)).rejects.toMatchObject({
        code: 'operator.denied',
      });
      // A session revoked since the token was issued.
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${agent.sessionId}`;
      await expect(record(agent.context, who.userId)).rejects.toMatchObject({ code: 'operator.denied' });
      // A closed account takes no notice.
      const closed = await customer();
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${closed.userId}`;
      await expect(record((await operator()).context, closed.userId)).rejects.toMatchObject({
        code: 'identity.death_notice_account_closed',
      });
      expect(await db.sql`SELECT id FROM death_notices WHERE subject_user_id IN ${db.sql([who.userId, closed.userId])}`).toHaveLength(0);
    });

    it('confirming spends a second person’s approval, freezes the account and revokes its sessions and API keys', async () => {
      const { who, agent, second, notice, approvalId } = await confirmed();
      expect(notice).toMatchObject({ status: 'confirmed', decidedBy: agent.userId, approvedBy: second.userId });
      expect(await account(who.userId)).toEqual({ status: 'frozen', live: 0, keys: 0 });
      expect(await approvalStatus(approvalId)).toBe('CONSUMED');
      // Confirming again answers the notice as it stands.
      const again = await confirmDeathNotice(deps, agent.context, { noticeId: notice.noticeId, approvalId });
      expect(again).toMatchObject({ status: 'confirmed', approvedBy: second.userId });
      // A second notice for the same account cannot be confirmed too.
      const other = await record(agent.context, who.userId, 'CASE-2');
      const otherApproval = await approval({
        userId: who.userId,
        noticeId: other.noticeId,
        requester: agent.userId,
        approver: second.userId,
      });
      await expect(confirmDeathNotice(deps, agent.context, { noticeId: other.noticeId, approvalId: otherApproval })).rejects.toMatchObject({
        code: 'identity.death_notice_already_confirmed',
      });
      expect(await approvalStatus(otherApproval)).toBe('APPROVED');
    });

    it('refuses any approval that is not this notice’s, approved by someone else, and changes nothing', async () => {
      const who = await customer();
      const agent = await operator();
      const second = await operator();
      const notice = await record(agent.context, who.userId);
      const refuse = async (approvalId: string, context: Context = agent.context) => {
        await expect(confirmDeathNotice(deps, context, { noticeId: notice.noticeId, approvalId })).rejects.toMatchObject({
          code: 'identity.death_notice_approval_required',
        });
      };
      await refuse('apr-missing');
      await refuse(await approval({ userId: who.userId, noticeId: notice.noticeId, requester: agent.userId, approver: null }));
      await refuse(await approval({ userId: who.userId, noticeId: notice.noticeId, requester: agent.userId, approver: who.userId }));
      await refuse(
        await approval({
          userId: who.userId,
          noticeId: notice.noticeId,
          requester: agent.userId,
          approver: second.userId,
          hash: 'f'.repeat(64),
        }),
      );
      // Requested by someone else: the person confirming must be the one who asked.
      const third = await operator();
      await refuse(await approval({ userId: who.userId, noticeId: notice.noticeId, requester: third.userId, approver: second.userId }));
      // Another account's approval.
      const elsewhere = await customer();
      await refuse(
        await approval({ userId: elsewhere.userId, noticeId: notice.noticeId, requester: agent.userId, approver: second.userId }),
      );
      const expired = await approval({ userId: who.userId, noticeId: notice.noticeId, requester: agent.userId, approver: second.userId });
      await db.sql`UPDATE action_approvals SET expires_at = now() - interval '1 minute' WHERE approval_id = ${expired}`;
      await refuse(expired);
      expect(await account(who.userId)).toMatchObject({ status: 'active', live: 1, keys: 1 });
      expect((await listDeathNotices(deps, agent.context, who.userId))[0]).toMatchObject({ status: 'received' });
    });

    it('a rejected notice changes nothing and cannot be confirmed later', async () => {
      const who = await customer();
      const agent = await operator();
      const second = await operator();
      const notice = await record(agent.context, who.userId);
      const rejected = await rejectDeathNotice(deps, (await operator()).context, notice.noticeId);
      expect(rejected).toMatchObject({ status: 'rejected' });
      expect((await rejectDeathNotice(deps, agent.context, notice.noticeId)).status).toBe('rejected');
      const approvalId = await approval({
        userId: who.userId,
        noticeId: notice.noticeId,
        requester: agent.userId,
        approver: second.userId,
      });
      await expect(confirmDeathNotice(deps, agent.context, { noticeId: notice.noticeId, approvalId })).rejects.toMatchObject({
        code: 'identity.death_notice_not_open',
      });
      expect(await approvalStatus(approvalId)).toBe('APPROVED');
      expect(await account(who.userId)).toMatchObject({ status: 'active', live: 1, keys: 1 });
      // A confirmed notice is not rejected.
      const done = await confirmed();
      await expect(rejectDeathNotice(deps, done.agent.context, done.notice.noticeId)).rejects.toMatchObject({
        code: 'identity.death_notice_not_open',
      });
    });

    it('publishes created, then confirmed, once each with the business key', async () => {
      await db.sql`UPDATE death_notices SET created_published_at = now(), confirmed_published_at = now()`;
      const who = await customer();
      const agent = await operator();
      const second = await operator();
      const notice = await record(agent.context, who.userId);
      bus.reset();
      expect(await relayDeathNoticeEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(1);
      expect(bus.emitted('deathNoticeCreated').map((e) => e.payload)).toEqual([
        { userId: who.userId, noticeId: notice.noticeId, at: notice.receivedAt },
      ]);
      expect(await relayDeathNoticeEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(0);
      const approvalId = await approval({
        userId: who.userId,
        noticeId: notice.noticeId,
        requester: agent.userId,
        approver: second.userId,
      });
      const done = await confirmDeathNotice(deps, agent.context, { noticeId: notice.noticeId, approvalId });
      expect(await relayDeathNoticeEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(1);
      const sent = bus.emitted('deathNoticeConfirmed');
      expect(sent.map((e) => e.payload)).toEqual([{ userId: who.userId, noticeId: notice.noticeId, at: done.decidedAt }]);
      expect(sent[0]!.idempotencyKey).toBe(`identity.death_notice.confirmed:${notice.noticeId}`);
      expect(bus.emitted('deathNoticeCreated')[0]!.idempotencyKey).toBe(`identity.death_notice.created:${notice.noticeId}`);
      expect(await relayDeathNoticeEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(0);
    });

    it('a publish that fails leaves the row unpublished, for the next run to send again', async () => {
      await db.sql`UPDATE death_notices SET created_published_at = now(), confirmed_published_at = now()`;
      const who = await customer();
      const notice = await record((await operator()).context, who.userId);
      const failing = { publish: async () => Promise.reject(new Error('bus down')) };
      await expect(relayDeathNoticeEvents({ sql: db.sql, bus: failing, now: () => new Date() })).rejects.toThrow('bus down');
      const [row] = await db.sql<Array<{ created_published_at: Date | null }>>`
        SELECT created_published_at FROM death_notices WHERE id = ${notice.noticeId}`;
      expect(row!.created_published_at).toBeNull();
      bus.reset();
      expect(await relayDeathNoticeEvents({ sql: db.sql, bus, now: () => new Date() })).toBe(1);
    });

    it('one notice whose publish keeps failing does not hold back the others', async () => {
      await db.sql`UPDATE death_notices SET created_published_at = now(), confirmed_published_at = now()`;
      const agent = await operator();
      const first = await record(agent.context, (await customer()).userId);
      const second = await record(agent.context, (await customer()).userId);
      const sent: string[] = [];
      const picky = {
        publish: async (_name: string, payload: { noticeId: string }) => {
          if (payload.noticeId === first.noticeId) throw new Error('rejected');
          sent.push(payload.noticeId);
        },
      } as unknown as Parameters<typeof relayDeathNoticeEvents>[0]['bus'];
      await expect(relayDeathNoticeEvents({ sql: db.sql, bus: picky, now: () => new Date() })).rejects.toThrow('rejected');
      expect(sent).toEqual([second.noticeId]);
      const rows = await db.sql<Array<{ id: string; published: boolean }>>`
        SELECT id, created_published_at IS NOT NULL AS published FROM death_notices WHERE id IN ${db.sql([first.noticeId, second.noticeId])}`;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.published]))).toEqual({ [first.noticeId]: false, [second.noticeId]: true });
    });
  });

  describe('recovery claim check (RC-identity-08)', () => {
    type Key = { privateKey: KeyObject; publicKey: RecoveryPublicJwk; id: string };
    async function addKey(userId: string, label: string): Promise<Key> {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const;
      const [row] = await db.sql<Array<{ id: string }>>`
        INSERT INTO recovery_keys (user_id, kind, public_material_hash, label)
        VALUES (${userId}, 'key', ${await fingerprintOf(publicKey)}, ${label}) RETURNING id`;
      return { privateKey: pair.privateKey, publicKey, id: row!.id };
    }
    const signWith = (key: Key, claim: { userId: string; heirUserId: string; claimId: string }) => ({
      publicKey: key.publicKey,
      signature: sign('sha256', Buffer.from(recoveryClaimMessage(claim)), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
        'base64url',
      ),
    });
    /** A dead owner with two keys, a threshold of 2 and a named heir, and a confirmed notice. */
    async function estate(opts: { confirm?: boolean } = {}) {
      const owner = await customer();
      const heir = await customer();
      const sister = await addKey(owner.userId, 'Sister');
      const friend = await addKey(owner.userId, 'Friend');
      await db.sql`INSERT INTO recovery_plans (user_id, heir_user_id, threshold) VALUES (${owner.userId}, ${heir.userId}, 2)`;
      let noticeId: string | null = null;
      if (opts.confirm !== false) {
        const agent = await operator();
        const second = await operator();
        const notice = await record(agent.context, owner.userId);
        const approvalId = await approval({
          userId: owner.userId,
          noticeId: notice.noticeId,
          requester: agent.userId,
          approver: second.userId,
        });
        noticeId = (await confirmDeathNotice(deps, agent.context, { noticeId: notice.noticeId, approvalId })).noticeId;
      }
      const claim = { userId: owner.userId, heirUserId: heir.userId, claimId: randomUUID() };
      return { owner, heir, sister, friend, noticeId, claim };
    }

    it('answers yes for enough distinct live keys signing this claim for the named heir', async () => {
      const { sister, friend, noticeId, claim } = await estate();
      const verdict = await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(friend, claim)] });
      expect(verdict).toEqual({ ok: true, noticeId, threshold: 2, signerKeyIds: [sister.id, friend.id].sort() });
    });

    it('refuses without a confirmed notice, or once the account is restored', async () => {
      const { sister, friend, claim } = await estate({ confirm: false });
      const signatures = [signWith(sister, claim), signWith(friend, claim)];
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures })).toEqual({
        ok: false,
        code: 'identity.recovery_notice_unconfirmed',
      });
      // Frozen for another reason, with no notice.
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${claim.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures })).toEqual({
        ok: false,
        code: 'identity.recovery_notice_unconfirmed',
      });

      // Restored since (a restore bumps the version, as founder-controls does), and then frozen again for another reason.
      const restored = await estate();
      const again = [signWith(restored.sister, restored.claim), signWith(restored.friend, restored.claim)];
      await db.sql`UPDATE users SET status = 'active', identity_control_version = identity_control_version + 1 WHERE id = ${restored.owner.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...restored.claim, signatures: again })).toEqual({
        ok: false,
        code: 'identity.recovery_account_changed',
      });
      await db.sql`UPDATE users SET status = 'frozen', identity_control_version = identity_control_version + 1 WHERE id = ${restored.owner.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...restored.claim, signatures: again })).toEqual({
        ok: false,
        code: 'identity.recovery_account_changed',
      });
    });

    it('refuses another heir, a heir no longer active, and an account with no plan', async () => {
      const { sister, friend, heir, claim } = await estate();
      const stranger = await customer();
      const theirs = { ...claim, heirUserId: stranger.userId };
      expect(await verifyRecoveryClaim(db.sql, { ...theirs, signatures: [signWith(sister, theirs), signWith(friend, theirs)] })).toEqual({
        ok: false,
        code: 'identity.recovery_heir_mismatch',
      });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${heir.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(friend, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_heir_inactive',
      });
      await db.sql`DELETE FROM recovery_plans WHERE user_id = ${claim.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_threshold_unset',
      });
    });

    it('a heir named or a key added after the notice was recorded does not count', async () => {
      const { owner, sister, friend, claim } = await estate();
      const late = await addKey(owner.userId, 'Late');
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(late, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_changed_after_notice',
      });
      await db.sql`UPDATE recovery_plans SET updated_at = now() WHERE user_id = ${owner.userId}`;
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(friend, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_changed_after_notice',
      });
    });

    it('counts each key once, and refuses too few signers', async () => {
      const { sister, claim } = await estate();
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_signatures_short',
      });
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(sister, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_signatures_short',
      });
    });

    it('refuses a revoked key, a key the owner never set, and a signature over another claim', async () => {
      const { owner, sister, friend, claim } = await estate();
      await db.sql`UPDATE recovery_keys SET revoked_at = now() WHERE id = ${friend.id}`;
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(friend, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_key_revoked',
      });
      // A key of another account is not one of this owner's.
      const elsewhere = await customer();
      const outsider = await addKey(elsewhere.userId, 'Outsider');
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(outsider, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_key_unknown',
      });
      await db.sql`UPDATE recovery_keys SET revoked_at = NULL WHERE id = ${friend.id}`;
      // Signed for another claim of the same estate: a signature answers for its own claim only.
      const otherClaim = { ...claim, claimId: randomUUID() };
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [signWith(sister, claim), signWith(friend, otherClaim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_signature_invalid',
      });
      // Garbage that is not a signature, and a point that is not on the curve.
      const garbage = { publicKey: sister.publicKey, signature: 'A'.repeat(86) };
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [garbage, signWith(friend, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_signature_invalid',
      });
      const offCurve = { publicKey: { ...sister.publicKey, y: sister.publicKey.x }, signature: signWith(sister, claim).signature };
      expect(await verifyRecoveryClaim(db.sql, { ...claim, signatures: [offCurve, signWith(friend, claim)] })).toEqual({
        ok: false,
        code: 'identity.recovery_signature_invalid',
      });
      expect(owner.userId).toBe(claim.userId);
    });
  });
}
