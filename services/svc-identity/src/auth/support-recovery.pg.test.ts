/**
 * Support-assisted recovery against Postgres (I-signin-sessions-24; J-identity-05 #5, J-identity-19 #1-#3): an operator
 * opens a case, a different operator approves it, the opener sends a one-time link to the proved address, and the link
 * works once. No answer carries the link; every refusal changes nothing.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import { localMailLine } from './local-mail.js';
import { totp } from './totp.js';
import {
  SUPPORT_RECOVERY_ACTION_TYPE,
  cancelSupportRecoveryCase,
  openSupportRecoveryCase,
  readSupportRecoveryCase,
  redeemSupportRecoveryLink,
  sendSupportRecoveryLink,
  supportRecoveryPayloadHash,
  type SupportRecoveryDeps,
} from './support-recovery.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const tokenConfig = {
  secret: 'an-identity-support-recovery-test-secret-long-enough',
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
  describe.skip('support recovery (Postgres unavailable)', () => {
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
  const totpKey = randomBytes(32);
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(
    db.sql,
    bus,
    new RankService(db.sql, bus),
    tokenConfig,
    webauthnConfig,
    totpKey.toString('base64'),
    undefined,
    undefined,
    25,
  );
  auth.useLogger({ warn: () => undefined });
  const sent: unknown[] = [];
  const deps = (over: Partial<SupportRecoveryDeps> = {}): SupportRecoveryDeps => ({
    sql: db.sql,
    mail: { send: async (message) => void sent.push(message) },
    linkTtlSeconds: 900,
    subjectKey: 'a-support-recovery-flow-key-that-is-long-enough',
    now: () => new Date(),
    ...over,
  });

  let n = 0;
  /** A TEST account with a password, a proved address and the authenticator app with recovery codes. */
  async function customer(opts: { proved?: boolean } = {}) {
    const handle = `sr${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    if (opts.proved !== false) await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
    const started = await auth.startTotpEnrolment(session.userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(session.userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    await db.sql`UPDATE users SET recovery_code_hashes = ${db.sql.json(['h1', 'h2'] as never)} WHERE id = ${session.userId}`;
    return { userId: session.userId, handle };
  }
  /** An operator: a live session with its second factor, and a token with the scopes asked for. */
  async function operator(scopes: string[] = ['admin:write', 'admin:compliance'], mfa = true) {
    const handle = `op${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    await db.sql`UPDATE sessions SET mfa = ${mfa} WHERE id = ${session.sessionId}`;
    const { token } = await issueAccessToken(
      { userId: session.userId, sessionId: session.sessionId, scopes, tier: 'none', mfa },
      tokenConfig,
    );
    const context: Context = {
      principal: await verifyAccessToken(token, tokenConfig),
      service: null,
      region: 'DE',
      requestId: 'sr',
    } as Context;
    return { userId: session.userId, sessionId: session.sessionId, context };
  }
  async function approval(opts: { userId: string; caseId: string; requester: string; approver: string | null; hash?: string }) {
    const approvalId = `apr-${randomUUID()}`;
    await db.sql`
      INSERT INTO action_approvals (
        approval_id, action_type, target_service, target_id, expected_version, payload_hash,
        requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at
      ) VALUES (
        ${approvalId}, ${SUPPORT_RECOVERY_ACTION_TYPE}, 'svc-identity', ${opts.userId}, '1',
        ${opts.hash ?? supportRecoveryPayloadHash(opts.userId, opts.caseId)}, ${opts.requester}, ${opts.approver}, '1', ${randomUUID()},
        ${opts.approver ? 'APPROVED' : 'PENDING'}, now(), now() + interval '1 hour', ${opts.approver ? new Date() : null}
      )`;
    return approvalId;
  }
  const approvalStatus = async (approvalId: string) =>
    (await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`)[0]!.status;
  const links = (userId: string) =>
    db.sql<Array<{ code: string | null; recipient: string; status: string }>>`
      SELECT code, recipient, status FROM mail_outbox WHERE user_id = ${userId} AND purpose = 'support-recovery'`;
  const account = async (userId: string) =>
    (
      await db.sql<Array<{ totp_secret: string | null; codes: number; live: number; trusted: number; keys: number }>>`
        SELECT u.totp_secret, jsonb_array_length(u.recovery_code_hashes)::int AS codes,
          (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked = false) AS live,
          (SELECT count(*)::int FROM trusted_devices d WHERE d.user_id = u.id AND d.removed_at IS NULL) AS trusted,
          (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked = false) AS keys
        FROM users u WHERE u.id = ${userId}`
    )[0]!;

  /** Opens a case for a new customer, has a second operator approve it, and sends the link. Answers the mailed token. */
  async function sentLink() {
    const who = await customer();
    const agent = await operator();
    const second = await operator();
    const opened = await openSupportRecoveryCase(deps(), agent.context, {
      userId: who.userId,
      reason: 'Lost phone, verified on a call',
      requestId: 'r1',
    });
    const approvalId = await approval({ userId: who.userId, caseId: opened.caseId, requester: agent.userId, approver: second.userId });
    const view = await sendSupportRecoveryLink(deps(), agent.context, { caseId: opened.caseId, approvalId });
    const [mail] = await links(who.userId);
    return { who, agent, second, opened, approvalId, view, token: mail!.code! };
  }

  describe('support recovery', () => {
    it('a case shows the masked address and live sessions, no link yet, and the same request answers the same case', async () => {
      const who = await customer();
      const agent = await operator();
      const opened = await openSupportRecoveryCase(deps(), agent.context, {
        userId: who.userId,
        reason: 'Lost phone',
        requestId: 'open-1',
      });
      expect(opened).toMatchObject({
        userId: who.userId,
        handle: who.handle,
        state: 'open',
        openedBy: agent.userId,
        approvedBy: null,
        linkSentAt: null,
      });
      expect(opened.contact).toEqual({ email: expect.not.stringContaining(who.handle), emailProved: true });
      expect(opened.sessions.length).toBeGreaterThanOrEqual(1);
      expect(opened.approvalProposal).toEqual({
        actionType: 'identity.support_recovery_link',
        targetService: 'svc-identity',
        targetId: who.userId,
        expectedVersion: '1',
        payloadHash: supportRecoveryPayloadHash(who.userId, opened.caseId),
      });
      expect(JSON.stringify(opened)).not.toMatch(/token/i);
      expect(await links(who.userId)).toHaveLength(0);

      const again = await openSupportRecoveryCase(deps(), agent.context, { userId: who.userId, reason: 'Lost phone', requestId: 'open-1' });
      expect(again.caseId).toBe(opened.caseId);
      await expect(
        openSupportRecoveryCase(deps(), agent.context, { userId: who.userId, reason: 'Something else', requestId: 'open-1' }),
      ).rejects.toMatchObject({ code: 'identity.support_recovery_request_reused' });
      // Another operator opening for the same account finds the open case.
      const other = await operator();
      const theirs = await openSupportRecoveryCase(deps(), other.context, { userId: who.userId, reason: 'Called again', requestId: 'x' });
      expect(theirs.caseId).toBe(opened.caseId);
      expect(await readSupportRecoveryCase(deps(), other.context, opened.caseId)).toMatchObject({ state: 'open' });
      // Every read of a case lists the account's sessions, so each is in the operator read audit.
      const audited = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM operator_read_audit WHERE actor_id IN ${db.sql([agent.userId, other.userId])} AND kind = 'session_list'`;
      expect(audited[0]!.n).toBe(4);
    });

    it('only an operator with a second factor on a live session opens a case, never for their own account or an unproved address', async () => {
      const who = await customer();
      const plain = await operator(['identity:read']);
      await expect(
        openSupportRecoveryCase(deps(), plain.context, { userId: who.userId, reason: 'r', requestId: 'a' }),
      ).rejects.toMatchObject({
        code: 'operator.denied',
      });
      const noFactor = await operator(['admin:write'], false);
      await expect(
        openSupportRecoveryCase(deps(), noFactor.context, { userId: who.userId, reason: 'r', requestId: 'a' }),
      ).rejects.toMatchObject({ code: 'mfa.required' });
      const agent = await operator();
      await expect(
        openSupportRecoveryCase(deps(), agent.context, { userId: agent.userId, reason: 'r', requestId: 'a' }),
      ).rejects.toMatchObject({ code: 'identity.support_recovery_self' });
      const unproved = await customer({ proved: false });
      await expect(
        openSupportRecoveryCase(deps(), agent.context, { userId: unproved.userId, reason: 'r', requestId: 'b' }),
      ).rejects.toMatchObject({ code: 'identity.support_recovery_no_proved_address' });
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${agent.sessionId}`;
      await expect(
        openSupportRecoveryCase(deps(), agent.context, { userId: who.userId, reason: 'r', requestId: 'c' }),
      ).rejects.toMatchObject({
        code: 'operator.denied',
      });
      expect(await db.sql`SELECT 1 FROM support_recovery_cases WHERE user_id IN ${db.sql([who.userId, unproved.userId])}`).toHaveLength(0);
    });

    it('the link is sent only with an approval a different person gave for this account and case, and it is spent', async () => {
      const who = await customer();
      const agent = await operator();
      const second = await operator();
      const opened = await openSupportRecoveryCase(deps(), agent.context, { userId: who.userId, reason: 'Lost phone', requestId: 'r' });
      const refuse = (approvalId: string) =>
        expect(sendSupportRecoveryLink(deps(), agent.context, { caseId: opened.caseId, approvalId })).rejects.toMatchObject({
          code: 'identity.support_recovery_approval_required',
        });
      await refuse('apr-missing');
      await refuse(await approval({ userId: who.userId, caseId: opened.caseId, requester: agent.userId, approver: null }));
      // One person approving their own request is refused by the approvals table itself (action_approvals_distinct_ck).
      await refuse(await approval({ userId: who.userId, caseId: opened.caseId, requester: second.userId, approver: agent.userId }));
      await refuse(await approval({ userId: who.userId, caseId: opened.caseId, requester: agent.userId, approver: who.userId }));
      await refuse(
        await approval({
          userId: who.userId,
          caseId: opened.caseId,
          requester: agent.userId,
          approver: second.userId,
          hash: supportRecoveryPayloadHash(who.userId, randomUUID()),
        }),
      );
      // Only the opener sends it.
      const good = await approval({ userId: who.userId, caseId: opened.caseId, requester: agent.userId, approver: second.userId });
      await expect(sendSupportRecoveryLink(deps(), second.context, { caseId: opened.caseId, approvalId: good })).rejects.toMatchObject({
        code: 'operator.denied',
      });
      // Blank settings refuse before the approval is spent.
      await expect(
        sendSupportRecoveryLink(deps({ linkTtlSeconds: undefined }), agent.context, { caseId: opened.caseId, approvalId: good }),
      ).rejects.toMatchObject({ code: 'identity.support_recovery_unconfigured' });
      await expect(
        sendSupportRecoveryLink(deps({ subjectKey: undefined }), agent.context, { caseId: opened.caseId, approvalId: good }),
      ).rejects.toMatchObject({ code: 'auth.codes_unwired' });
      await expect(
        sendSupportRecoveryLink(deps({ mail: undefined }), agent.context, { caseId: opened.caseId, approvalId: good }),
      ).rejects.toMatchObject({
        code: 'vendor.email',
      });
      expect(await approvalStatus(good)).toBe('APPROVED');
      expect(await links(who.userId)).toHaveLength(0);
      expect((await readSupportRecoveryCase(deps(), agent.context, opened.caseId)).state).toBe('open');

      const view = await sendSupportRecoveryLink(deps(), agent.context, { caseId: opened.caseId, approvalId: good });
      expect(view).toMatchObject({ state: 'link_sent', approvedBy: second.userId });
      expect(view.linkExpiresAt).not.toBeNull();
      expect(JSON.stringify(view)).not.toMatch(/token/i);
      expect(await approvalStatus(good)).toBe('CONSUMED');
      const mailed = await links(who.userId);
      expect(mailed).toHaveLength(1);
      expect(mailed[0]).toMatchObject({ recipient: `${who.handle}@example.com`, status: 'pending' });
      expect(JSON.stringify(view)).not.toContain(mailed[0]!.code!);
      expect(
        localMailLine({ email: mailed[0]!.recipient, code: mailed[0]!.code!, expiresAt: new Date(), purpose: 'support-recovery' }),
      ).toContain(`link=recover-account?token=${mailed[0]!.code}`);
      // Sending again answers the case and mails nothing more.
      expect((await sendSupportRecoveryLink(deps(), agent.context, { caseId: opened.caseId, approvalId: good })).state).toBe('link_sent');
      expect(await links(who.userId)).toHaveLength(1);
    });

    it('the link works once: the app and its codes go, every session ends, and the owner is told', async () => {
      const { who, opened, token, agent } = await sentLink();
      // The lost phone was a trusted device, and an API key was made from it.
      await db.sql`INSERT INTO trusted_devices (user_id, device_key_hash, label, trusted_by) VALUES (${who.userId}, ${'d'.repeat(64)}, 'TEST lost phone', 'sign-in')`;
      await db.sql`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes)
        VALUES (${who.userId}, 'TEST key', ${`h${randomUUID()}`}, 'ifc_t', ARRAY['trade:read'])`;
      const before = await account(who.userId);
      expect(before).toMatchObject({ codes: 2, keys: 1 });
      expect(before.trusted).toBeGreaterThan(0);
      expect((await account(who.userId)).totp_secret).not.toBeNull();
      expect((await account(who.userId)).live).toBeGreaterThan(0);

      expect(await redeemSupportRecoveryLink(deps(), { token })).toEqual({ recovered: true });
      expect(await account(who.userId)).toEqual({ totp_secret: null, codes: 0, live: 0, trusted: 0, keys: 0 });
      const view = await readSupportRecoveryCase(deps(), agent.context, opened.caseId);
      expect(view.state).toBe('used');
      expect(view.usedAt).not.toBeNull();
      const notices = await db.sql<Array<{ purpose: string }>>`
        SELECT purpose FROM mail_outbox WHERE user_id = ${who.userId} AND purpose = 'support-recovery-used'`;
      expect(notices).toHaveLength(1);
      const factor = await db.sql<
        Array<{ change: string }>
      >`SELECT change FROM security_factor_events WHERE user_id = ${who.userId} ORDER BY created_at`;
      expect(factor.map((f) => f.change)).toEqual(['totp_added', 'totp_removed']);

      await expect(redeemSupportRecoveryLink(deps(), { token })).rejects.toMatchObject({ code: 'identity.support_recovery_link_invalid' });
      await expect(redeemSupportRecoveryLink(deps(), { token: randomBytes(32).toString('base64url') })).rejects.toMatchObject({
        code: 'identity.support_recovery_link_invalid',
      });
      await expect(redeemSupportRecoveryLink(deps(), { token: 'short' })).rejects.toMatchObject({
        code: 'identity.support_recovery_link_invalid',
      });
      // The password still signs in, now with no second step.
      const back = await auth.login({ identifier: who.handle, password: 'correct horse battery staple' });
      expect(back).toMatchObject({ userId: who.userId });
    });

    it('a cancelled case or an expired link does not work, and the next case can be opened', async () => {
      const first = await sentLink();
      await cancelSupportRecoveryCase(deps(), first.agent.context, first.opened.caseId);
      await expect(redeemSupportRecoveryLink(deps(), { token: first.token })).rejects.toMatchObject({
        code: 'identity.support_recovery_link_invalid',
      });
      expect((await account(first.who.userId)).totp_secret).not.toBeNull();

      const later = await sentLink();
      await db.sql`UPDATE support_recovery_cases SET link_expires_at = now() - interval '1 second', link_sent_at = now() - interval '2 seconds'
        WHERE id = ${later.opened.caseId}`;
      await expect(redeemSupportRecoveryLink(deps(), { token: later.token })).rejects.toMatchObject({
        code: 'identity.support_recovery_link_invalid',
      });
      expect((await readSupportRecoveryCase(deps(), later.agent.context, later.opened.caseId)).state).toBe('expired');
      const next = await openSupportRecoveryCase(deps(), later.agent.context, {
        userId: later.who.userId,
        reason: 'Again',
        requestId: 'r2',
      });
      expect(next.caseId).not.toBe(later.opened.caseId);
      expect(next.state).toBe('open');
    });

    it('while the account’s security lock holds, the link is not used', async () => {
      const { who, token } = await sentLink();
      await db.sql`INSERT INTO account_security_locks (user_id, set_by, set_by_user_id) VALUES (${who.userId}, 'self', ${who.userId})`;
      await expect(redeemSupportRecoveryLink(deps(), { token })).rejects.toMatchObject({ code: 'identity.security_locked' });
      expect((await account(who.userId)).totp_secret).not.toBeNull();
      await db.sql`UPDATE account_security_locks SET state = 'ended', ended_at = now() WHERE user_id = ${who.userId}`;
      expect(await redeemSupportRecoveryLink(deps(), { token })).toEqual({ recovered: true });
    });

    it('with the flow key unset, a link is never checked', async () => {
      const { token } = await sentLink();
      await expect(redeemSupportRecoveryLink(deps({ subjectKey: undefined }), { token })).rejects.toMatchObject({
        code: 'auth.codes_unwired',
      });
    });
  });
}
