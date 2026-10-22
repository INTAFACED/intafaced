/**
 * Legal agreements register against Postgres (RC-identity-12, TRD-0631): four-eyes publish with typed refusals for blank
 * text and venue, immutable versions, idempotent acceptance, current-version state per kind, organisation signers.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { AGREEMENT_PUBLISH_ACTION, type Context, type TRPCError } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { identityActionPayloadHash } from '../auth/privileged-dual-control.js';
import { AgreementService, agreementPublishFields } from './agreement-service.js';
import { createAgreementRouter } from './agreement-router.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'an-agreements-register-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);

if (!available) {
  describe.skip('agreements (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  const founders = new Set<string>();
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), {
    ttlSeconds: 600,
    founders: { isFounder: async (id: string) => founders.has(id) },
  });
  const api = createAgreementRouter(new AgreementService(db.sql, approvals));

  const seed = async (scopes: string[] = ['identity:read', 'identity:write']): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `a${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: scopes as never, mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const caller = (ctx: Context) => api.createCaller(ctx);
  async function refusal(run: Promise<unknown>) {
    try {
      await run;
    } catch (err) {
      const wrapped = err as TRPCError & { cause?: { code?: string } };
      return { trpc: wrapped.code, code: wrapped.cause?.code };
    }
    throw new Error('expected a refusal');
  }

  let maker: Context;
  let checker: Context;
  beforeEach(async () => {
    await db.truncateAll();
    maker = await seed(['admin:compliance']);
    checker = await seed(['admin:compliance']);
    founders.clear();
    founders.add(maker.principal!.userId).add(checker.principal!.userId);
  });
  afterAll(async () => {
    await db.drop();
  });

  const text = { kind: 'trading' as const, jurisdiction: 'EU', textRef: 'docs/legal/trading-v1.pdf', disputeVenue: 'Courts of Dublin' };
  async function approve(input: typeof text) {
    const payloadHash = identityActionPayloadHash(AGREEMENT_PUBLISH_ACTION, agreementPublishFields(input));
    const pending = await approvals.propose(maker.principal!.userId, {
      actionType: AGREEMENT_PUBLISH_ACTION,
      targetService: 'svc-identity',
      targetId: AGREEMENT_PUBLISH_ACTION,
      expectedVersion: '1',
      payloadHash,
      policyVersion: 'agreements-v1',
    });
    const done = await approvals.approve(checker.principal!.userId, pending.approvalId, payloadHash);
    return { approvalId: done.approvalId, operationId: done.operationId };
  }
  async function publish(input: typeof text = text) {
    return caller(maker).agreements.publish({ ...input, ...(await approve(input)) });
  }

  it('publishes versions four-eyes; v2 shows "needs acceptance" with v1 still on record', async () => {
    expect(await publish()).toEqual({ kind: 'trading', version: 1 });
    const user = await seed();
    expect(await caller(user).agreements.accept({ kind: 'trading', version: 1 })).toEqual({ accepted: true, changed: true });
    expect((await caller(user).agreements.listMine({}))[0]).toMatchObject({
      kind: 'trading',
      currentVersion: 1,
      acceptedVersion: 1,
      needsAcceptance: false,
    });

    expect(await publish({ ...text, textRef: 'docs/legal/trading-v2.pdf' })).toEqual({ kind: 'trading', version: 2 });
    expect(await caller(user).agreements.listMine({})).toEqual([
      expect.objectContaining({
        kind: 'trading',
        currentVersion: 2,
        acceptedVersion: 1,
        needsAcceptance: true,
        textRef: 'docs/legal/trading-v2.pdf',
      }),
    ]);
    const kept = await db.sql`SELECT version, signer_user_id FROM agreement_acceptances WHERE subject_id = ${user.principal!.userId}`;
    expect(kept).toEqual([{ version: 1, signer_user_id: user.principal!.userId }]);
    // An old version can no longer be accepted.
    expect((await refusal(caller(user).agreements.accept({ kind: 'trading', version: 1 }))).code).toBe(
      'identity.agreement_version_not_current',
    );
  });

  it('accepting twice keeps one row', async () => {
    await publish();
    const user = await seed();
    await caller(user).agreements.accept({ kind: 'trading', version: 1 });
    expect(await caller(user).agreements.accept({ kind: 'trading', version: 1 })).toEqual({ accepted: true, changed: false });
    const counted = await db.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM agreement_acceptances WHERE subject_id = ${user.principal!.userId}`;
    expect(counted[0]?.n).toBe(1);
  });

  it('refuses blank text, blank venue and blank jurisdiction, and publishes nothing', async () => {
    for (const [bad, code] of [
      [{ disputeVenue: '  ' }, 'identity.dispute_venue_unset'],
      [{ textRef: '' }, 'identity.agreement_text_unset'],
      [{ jurisdiction: ' ' }, 'identity.agreement_jurisdiction_unset'],
    ] as const) {
      const r = await refusal(caller(maker).agreements.publish({ ...text, ...bad, approvalId: randomUUID(), operationId: randomUUID() }));
      expect(r).toMatchObject({ trpc: 'BAD_REQUEST', code });
    }
    expect(await db.sql`SELECT 1 FROM agreement_versions`).toHaveLength(0);
  });

  it('refuses a publish without an approval, or with one bound to other text', async () => {
    const none = await refusal(caller(maker).agreements.publish({ ...text }));
    expect(none).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.agreement_approval_refused' });
    const other = await approve({ ...text, textRef: 'docs/legal/other.pdf' });
    const mismatch = await refusal(caller(maker).agreements.publish({ ...text, ...other }));
    expect(mismatch.code).toBe('identity.agreement_approval_refused');
    expect(await db.sql`SELECT 1 FROM agreement_versions`).toHaveLength(0);
  });

  it('publishing is founder-ops: an approval by a non-founder is refused', async () => {
    founders.delete(checker.principal!.userId);
    await expect(approve(text)).rejects.toMatchObject({ code: 'action_approval.founder_only' });
    expect(await db.sql`SELECT 1 FROM agreement_versions`).toHaveLength(0);
  });

  it('published versions are immutable: an edit is refused and a new version is required', async () => {
    await publish();
    await expect(db.sql`UPDATE agreement_versions SET text_ref = 'edited' WHERE kind = 'trading' AND version = 1`).rejects.toThrow(
      /agreement_version_immutable/,
    );
    await expect(db.sql`DELETE FROM agreement_versions WHERE kind = 'trading'`).rejects.toThrow(/agreement_version_immutable/);
    expect(await publish({ ...text, textRef: 'docs/legal/trading-v2.pdf' })).toEqual({ kind: 'trading', version: 2 });
    const [v1] = await db.sql`SELECT text_ref FROM agreement_versions WHERE kind = 'trading' AND version = 1`;
    expect(v1?.text_ref).toBe('docs/legal/trading-v1.pdf');
  });

  it('only an organisation admin accepts for the organisation; a trader is refused', async () => {
    await publish();
    const admin = await seed();
    const trader = await seed();
    const outsider = await seed();
    const [org] = await db.sql<
      Array<{ id: string }>
    >`INSERT INTO organizations (name, created_by) VALUES ('Desk Ltd', ${admin.principal!.userId}) RETURNING id`;
    await db.sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${org!.id}, ${admin.principal!.userId}, 'admin'), (${org!.id}, ${trader.principal!.userId}, 'trader')`;

    const byTrader = await refusal(caller(trader).agreements.accept({ kind: 'trading', version: 1, orgId: org!.id }));
    expect(byTrader).toMatchObject({ trpc: 'FORBIDDEN', code: 'identity.agreement_signer_not_admin' });
    const byOutsider = await refusal(caller(outsider).agreements.listMine({ orgId: org!.id }));
    expect(byOutsider).toMatchObject({ trpc: 'NOT_FOUND', code: 'auth.not_found' });
    const outsiderSigns = await refusal(caller(outsider).agreements.accept({ kind: 'trading', version: 1, orgId: org!.id }));
    expect(outsiderSigns).toMatchObject({ trpc: 'NOT_FOUND', code: 'auth.not_found' });

    expect(await caller(admin).agreements.accept({ kind: 'trading', version: 1, orgId: org!.id })).toEqual({
      accepted: true,
      changed: true,
    });
    // A trader may read the organisation's state; the org row records the admin as signer.
    expect((await caller(trader).agreements.listMine({ orgId: org!.id }))[0]).toMatchObject({ acceptedVersion: 1, needsAcceptance: false });
    const rows = await db.sql`SELECT subject_type, signer_user_id FROM agreement_acceptances WHERE subject_id = ${org!.id}`;
    expect(rows).toEqual([{ subject_type: 'org', signer_user_id: admin.principal!.userId }]);
  });

  it('refuses an API key or a sub-account accepting, and an unpublished kind', async () => {
    await publish();
    const user = await seed();
    const asKey = await refusal(
      caller({ ...user, principal: { ...user.principal!, kid: 'key-1', scopes: ['identity:write'] } as never }).agreements.accept({
        kind: 'trading',
        version: 1,
      }),
    );
    expect(asKey.code).toBe('identity.agreement_delegated');
    const asSub = await refusal(
      caller({ ...user, principal: { ...user.principal!, sub_account: randomUUID() } as never }).agreements.accept({
        kind: 'trading',
        version: 1,
      }),
    );
    expect(asSub.code).toBe('identity.agreement_delegated');
    const none = await refusal(caller(user).agreements.accept({ kind: 'margin', version: 1 }));
    expect(none).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.agreement_not_published' });
  });

  it('agreements.requires answers services only, per subject and kind', async () => {
    const user = await seed();
    const svc = caller({ principal: null, service: 'svc-trade', region: 'DE', requestId: randomUUID() } as Context);
    expect(await svc.agreements.requires({ subjectId: user.principal!.userId, kind: 'trading' })).toEqual({
      kind: 'trading',
      currentVersion: null,
      acceptedVersion: null,
      required: false,
    });
    await publish();
    expect((await svc.agreements.requires({ subjectId: user.principal!.userId, kind: 'trading' })).required).toBe(true);
    await caller(user).agreements.accept({ kind: 'trading', version: 1 });
    expect(await svc.agreements.requires({ subjectId: user.principal!.userId, kind: 'trading' })).toEqual({
      kind: 'trading',
      currentVersion: 1,
      acceptedVersion: 1,
      required: false,
    });
    const byUser = await refusal(caller(user).agreements.requires({ subjectId: user.principal!.userId, kind: 'trading' }));
    expect(byUser.trpc).toBe('UNAUTHORIZED');
  });
}
