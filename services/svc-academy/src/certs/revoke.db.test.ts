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
    sent,
    async publish(_event: string, payload: unknown, opts: { idempotencyKey: string }) {
      if (bus.down) throw new Error('TEST bus refused');
      sent.push({ payload: payload as (typeof sent)[number]['payload'], idempotencyKey: opts.idempotencyKey });
    },
  };
  return bus;
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
    expect(bus.sent.map((e) => [e.payload.action, e.payload.xpDelta, e.idempotencyKey])).toEqual([
      ['cert.granted', 100, `academy.cert:cert:${USER}:${CERT}`],
    ]);
    const first = await revoke(academy, publicId);
    const reversalKey = `academy.cert-revoke:cert:${USER}:${CERT}`;
    expect(first.xpReversal).toEqual({ emitted: true, idempotencyKey: reversalKey, xpDelta: -100 });
    const reversals = bus.sent.filter((e) => e.payload.action === 'cert.revoked');
    expect(reversals).toEqual([
      {
        payload: { userId: USER, sourceModule: 'academy', action: 'cert.revoked', xpDelta: -100, meta: { certId: CERT } },
        idempotencyKey: reversalKey,
      },
    ]);
    // The award went out again first under its own key (identity drops it when it already landed).
    expect(bus.sent.at(-2)).toMatchObject({ idempotencyKey: `academy.cert:cert:${USER}:${CERT}`, payload: { xpDelta: 100 } });
    // A repeat answers the first record and publishes the reversal again under the same key: one reversal at identity.
    expect((await revoke(academy, publicId, 'TEST another reason')).xpReversal).toEqual(first.xpReversal);
    const again = bus.sent.filter((e) => e.payload.action === 'cert.revoked');
    expect(again).toHaveLength(2);
    expect(new Set(again.map((e) => e.idempotencyKey))).toEqual(new Set([reversalKey]));
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(1);
  });

  it('a failed publish leaves the revoke durable and says so; the next revoke publishes the reversal', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    bus.down = true;
    const first = await revoke(academy, publicId);
    expect(first.xpReversal).toEqual({ emitted: false, reason: 'publish_failed' });
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(1);
    expect(bus.sent.filter((e) => e.payload.action === 'cert.revoked')).toHaveLength(0);
    bus.down = false;
    const healed = await revoke(academy, publicId);
    expect(healed.xpReversal).toEqual({ emitted: true, idempotencyKey: `academy.cert-revoke:cert:${USER}:${CERT}`, xpDelta: -100 });
    expect(healed.revokedAt).toEqual(first.revokedAt);
    expect(bus.sent.filter((e) => e.payload.action === 'cert.revoked')).toHaveLength(1);
  });

  it('never reverses a certificate that still stands, and refuses an unknown code', async () => {
    const bus = recordingBus();
    const academy = service(publisherOver(bus));
    const publicId = await issued(academy);
    await expect(academy.reverseCertXp(publicId)).rejects.toMatchObject({ code: 'academy.cert_invalid' });
    await expect(academy.reverseCertXp('0'.repeat(32))).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    expect(bus.sent.filter((e) => e.payload.action === 'cert.revoked')).toHaveLength(0);
  });

  it('an unpriced certificate gave no XP, so its revoke publishes nothing and says no_policy', async () => {
    // The only catalog certificate is priced; the publisher's own policy refusal is what an unpriced one answers.
    const calls: string[] = [];
    const unpriced: CertXpPublisher = {
      id: 'unpriced',
      usable: true,
      async publishCertXp() {
        calls.push('award');
        return { emitted: false, reason: 'no_policy' };
      },
      async publishCertXpReversal() {
        calls.push('reversal');
        return { emitted: false, reason: 'no_policy' };
      },
    };
    const academy = service(unpriced);
    const publicId = await issued(academy);
    calls.length = 0;
    expect((await revoke(academy, publicId)).xpReversal).toEqual({ emitted: false, reason: 'no_policy' });
    expect(calls).toEqual(['award']);
  });
});
