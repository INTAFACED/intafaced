/**
 * AC-certificates-03: revoking an issued certificate against Postgres. The public check says revoked, one record names
 * both people, the reason and the time, a repeat writes nothing, and a revoked certificate is never issued again.
 * AC-certificates-02: the XP the grant was worth goes back to the rank ladder once, and a repeat re-publishes it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { EventBus } from '@intafaced/events';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { FOUNDATIONS_V1 } from './catalog.js';
import { BusCertXpPublisher, type CertXpPublisher } from './xp-publish.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const CERT = FOUNDATIONS_V1.id;
const PROPOSER = '66666666-6666-4666-8666-666666666666';
const APPROVER = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-10-24T12:00:00.000Z');

/** The publish half of a bus that records every xpEarned it carries, and can be switched to refuse. */
function recordingBus() {
  const sent: Array<{ payload: { action: string; xpDelta: number; userId: string }; idempotencyKey: string }> = [];
  const bus = {
    down: false,
    /** Refuse only this action (a bus that took the award and then dropped the reversal). */
    refuse: null as string | null,
    sent,
    async publish(_event: string, payload: unknown, opts: { idempotencyKey: string }) {
      const event = payload as (typeof sent)[number]['payload'];
      if (bus.down || bus.refuse === event.action) throw new Error('TEST bus refused');
      sent.push({ payload: event, idempotencyKey: opts.idempotencyKey });
    },
  };
  return bus;
}

/** What identity's rank holds from these events: each business key counts once (`ON CONFLICT DO NOTHING`). */
function identityNet(bus: ReturnType<typeof recordingBus>): number {
  const once = new Map(bus.sent.map((e) => [e.idempotencyKey, e.payload.xpDelta]));
  return [...once.values()].reduce((a, b) => a + b, 0);
}

/** The real publisher over that bus: the publish half is all it takes (the bus records the payload as it was given). */
const publisherOver = (bus: ReturnType<typeof recordingBus>) => new BusCertXpPublisher(bus as unknown as Pick<EventBus, 'publish'>);

function service(xp?: CertXpPublisher) {
  return new AcademyService(
    sql,
    { stakeOf: async () => 0n },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false },
    xp,
  );
}

async function issued(academy: AcademyService): Promise<string> {
  await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
  for (const itemSlug of FOUNDATIONS_V1.requiredItemSlugs) await academy.markCurriculumComplete({ userId: USER, itemSlug, now: T0 });
  return (await academy.grantCert({ userId: USER, certId: CERT })).grant.publicId;
}

const revoke = (academy: AcademyService, publicId: string, reason = 'TEST revoked in error') =>
  academy.revokeCert({ publicId, reason, proposedBy: PROPOSER, approvedBy: APPROVER, operatorId: OPERATOR, now: T0 });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('certificate revocation', () => {
  it('turns the public check to revoked and records both people, the reason and the time once', async () => {
    const academy = service();
    const publicId = await issued(academy);
    expect((await academy.certVerify(publicId)).status).toBe('valid');
    const first = await revoke(academy, publicId);
    const record = {
      publicId,
      certId: CERT,
      proposedBy: PROPOSER,
      approvedBy: APPROVER,
      revokedBy: OPERATOR,
      reason: 'TEST revoked in error',
      revokedAt: T0,
    };
    // No bus in this process: the revoke stands, and the answer says the XP reversal did not leave.
    expect(first).toEqual({ ...record, xpReversal: { emitted: false, reason: 'publisher_unavailable' } });
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
    // A repeat (a lost reply, a second click) answers with the first record and writes nothing.
    expect(await revoke(academy, publicId, 'TEST another reason')).toEqual(first);
    expect(await academy.certRevocation(publicId)).toEqual(record);
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(1);
  });

  it('a revoked certificate cannot be claimed again, and the holder sees it revoked', async () => {
    const academy = service();
    const publicId = await issued(academy);
    expect(await academy.certRevocation(publicId)).toBeNull();
    await revoke(academy, publicId);
    await expect(academy.grantCert({ userId: USER, certId: CERT })).rejects.toMatchObject({ code: 'academy.cert_revoked' });
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
    expect((await academy.myCertGrants(USER, 10))[0]).toMatchObject({ publicId, status: 'revoked' });
  });

  it('refuses an unknown or malformed code and a blank reason, writing nothing', async () => {
    const academy = service();
    const publicId = await issued(academy);
    await expect(academy.certRevocation('0'.repeat(32))).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(revoke(academy, '0'.repeat(32))).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(revoke(academy, 'not-a-code')).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(revoke(academy, publicId, '   ')).rejects.toMatchObject({ code: 'academy.cert_invalid' });
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(0);
    expect((await academy.certVerify(publicId)).status).toBe('valid');
  });

  it('takes back the XP the grant was worth once, under the business key, and a repeat re-publishes the same key', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    const awardKey = `academy.cert:cert:${USER}:${CERT}`;
    expect(bus.sent.map((e) => [e.payload.action, e.payload.xpDelta, e.idempotencyKey])).toEqual([['cert.granted', 100, awardKey]]);
    expect(identityNet(bus)).toBe(100);
    const first = await revoke(academy, publicId);
    const reversalKey = `academy.cert-revoke:cert:${USER}:${CERT}`;
    expect(first.xpReversal).toEqual({ emitted: true, idempotencyKey: reversalKey, xpDelta: -100 });
    // The award went out again first under its own key (identity drops it when it already landed), then the reversal.
    expect(bus.sent.slice(1).map((e) => [e.payload.action, e.payload.xpDelta, e.idempotencyKey])).toEqual([
      ['cert.granted', 100, awardKey],
      ['cert.revoked', -100, reversalKey],
    ]);
    expect(bus.sent.at(-1)?.payload).toEqual({
      userId: USER,
      sourceModule: 'academy',
      action: 'cert.revoked',
      xpDelta: -100,
      meta: { certId: CERT },
    });
    expect(identityNet(bus)).toBe(0);
    expect(await sql`SELECT xp_settled FROM academy.cert_revocations`).toEqual([{ xp_settled: 'reversed' }]);
    // A repeat answers the first record and publishes both again under the same keys: still net zero.
    expect((await revoke(academy, publicId, 'TEST another reason')).xpReversal).toEqual(first.xpReversal);
    expect(new Set(bus.sent.filter((e) => e.payload.action === 'cert.revoked').map((e) => e.idempotencyKey))).toEqual(
      new Set([reversalKey]),
    );
    expect(identityNet(bus)).toBe(0);
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(1);
    // Settled: the sweep has nothing left to send.
    const before = bus.sent.length;
    expect(await academy.settleRevokedCertXp()).toBe(0);
    expect(bus.sent).toHaveLength(before);
  });

  it('a reversal that fails after the award landed leaves the revoke durable and unsettled; the sweep restores net zero', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    bus.refuse = 'cert.revoked';
    const first = await revoke(academy, publicId);
    expect(first.xpReversal).toEqual({ emitted: false, reason: 'publish_failed' });
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
    // The award was re-sent and the reversal dropped: the learner still holds the XP, and the revocation is unsettled.
    expect(identityNet(bus)).toBe(100);
    expect(await sql`SELECT xp_settled FROM academy.cert_revocations`).toEqual([{ xp_settled: null }]);
    // The sweep tries again each pass; while the bus refuses it settles nothing.
    expect(await academy.settleRevokedCertXp()).toBe(0);
    expect(identityNet(bus)).toBe(100);
    bus.refuse = null;
    expect(await academy.settleRevokedCertXp()).toBe(1);
    expect(identityNet(bus)).toBe(0);
    expect(await sql`SELECT xp_settled FROM academy.cert_revocations`).toEqual([{ xp_settled: 'reversed' }]);
    expect(await academy.settleRevokedCertXp()).toBe(0);
    expect(identityNet(bus)).toBe(0);
  });

  it('a revoke whose award never landed and whose publish failed (or crashed) still converges to zero by the sweep', async () => {
    const bus = recordingBus();
    bus.down = true;
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    expect((await revoke(academy, publicId)).xpReversal).toEqual({ emitted: false, reason: 'publish_failed' });
    expect(bus.sent).toHaveLength(0);
    // Nothing reached identity yet; a crash right after the revoke committed leaves this same unsettled row.
    bus.down = false;
    expect(await academy.settleRevokedCertXp()).toBe(1);
    expect(bus.sent.map((e) => e.payload.action)).toEqual(['cert.granted', 'cert.revoked']);
    expect(identityNet(bus)).toBe(0);
  });

  it('takes back the amount the grant recorded, not a later policy, and refuses a guess when none was recorded', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    expect(await sql`SELECT xp_awarded FROM academy.cert_grants WHERE public_id = ${publicId}`).toEqual([{ xp_awarded: 100 }]);
    // A grant that recorded 70 (the policy was 70 then) gives back 70, whatever the policy says now.
    await sql`UPDATE academy.cert_grants SET xp_awarded = 70 WHERE public_id = ${publicId}`;
    expect((await revoke(academy, publicId)).xpReversal).toEqual({
      emitted: true,
      idempotencyKey: `academy.cert-revoke:cert:${USER}:${CERT}`,
      xpDelta: -70,
    });
    expect(bus.sent.slice(-2).map((e) => e.payload.xpDelta)).toEqual([70, -70]);

    // A priced grant issued before grants recorded their XP: nothing is taken back, and the answer says why.
    await db.truncateAll();
    const legacy = await issued(academy);
    await sql`UPDATE academy.cert_grants SET xp_awarded = NULL WHERE public_id = ${legacy}`;
    const sentBefore = bus.sent.length;
    expect((await revoke(academy, legacy)).xpReversal).toEqual({ emitted: false, reason: 'award_unrecorded' });
    expect(bus.sent).toHaveLength(sentBefore);
    expect(await sql`SELECT xp_settled FROM academy.cert_revocations`).toEqual([{ xp_settled: 'award_unrecorded' }]);
    expect(await academy.settleRevokedCertXp()).toBe(0);
  });

  it('never reverses a certificate that still stands, and refuses an unknown code', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    await expect(academy.reverseCertXp(publicId)).rejects.toMatchObject({ code: 'academy.cert_invalid' });
    await expect(academy.reverseCertXp('0'.repeat(32))).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    expect(bus.sent.filter((e) => e.payload.action === 'cert.revoked')).toHaveLength(0);
  });

  it('an unpriced grant recorded no XP, so its revoke publishes nothing and says no_policy', async () => {
    // The only catalog certificate is priced, so an unpriced grant is one that recorded no award and has no policy.
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    await sql`UPDATE academy.cert_grants SET xp_awarded = NULL, cert_id = 'not-in-policy-v1' WHERE public_id = ${publicId}`;
    const sentBefore = bus.sent.length;
    expect((await revoke(academy, publicId)).xpReversal).toEqual({ emitted: false, reason: 'no_policy' });
    expect(bus.sent).toHaveLength(sentBefore);
    expect(await sql`SELECT xp_settled FROM academy.cert_revocations`).toEqual([{ xp_settled: 'no_policy' }]);
  });
});
