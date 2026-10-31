import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDeliveryStore, PostgresTargetStore } from './channel-store.js';

/**
 * `PostgresDeliveryStore` against a real database.
 *
 * Until this file existed, nothing anywhere executed it. `svc-notify` had no
 * `TEST_DATABASE_URL_*` wiring, so the claim guard — the single statement the
 * whole no-double-send promise rests on, complete with its lease predicate and
 * an interval built by string concatenation — shipped proved by nothing but
 * reading. The memory store was covered and the two are meant to agree branch
 * for branch, which is exactly the kind of agreement that quietly stops being
 * true.
 *
 * Postgres is real here on purpose: every property worth asserting lives in the
 * statement, and a fake would test the fake.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? 'postgres://svc_notify:svc_notify@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));

/** Every migration, in order — the lease column arrives in 0004. */
const MIGRATIONS = [
  '0000_notify_init.sql',
  '0001_notify_channels.sql',
  '0002_notify_delivery_accepted.sql',
  '0003_notify_mute_prefs.sql',
  '0004_notify_delivery_claim_lease.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const available = await postgresAvailable(URL);
const NOTIFICATION = '11111111-1111-4111-8111-111111111111';
const OTHER_NOTIFICATION = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const sql = available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

if (available && sql) {
  // Asks the server for `current_database()` rather than trusting the URL, so a
  // suite that applies migrations cannot be aimed at the shared database.
  await assertTestDatabase(sql, 'svc-notify channel-store.pg.test');
  for (const migration of MIGRATIONS) {
    await sql.unsafe(migration).catch(() => undefined);
  }
}

afterAll(async () => {
  await sql?.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!available)('PostgresDeliveryStore — the claim guard, executed', () => {
  const store = () => new PostgresDeliveryStore(sql!, { leaseMs: 60_000 });

  beforeEach(async () => {
    await sql!`DELETE FROM notify.deliveries WHERE notification_id IN (${NOTIFICATION}, ${OTHER_NOTIFICATION})`;
    await sql!`DELETE FROM notify.notifications WHERE id IN (${NOTIFICATION}, ${OTHER_NOTIFICATION})`;
    // `deliveries.notification_id` is a foreign key: a delivery cannot exist
    // without the inbox row it belongs to. That is the design — there is no
    // orphan delivery — so the fixture has to build the parent.
    for (const [index, id] of [NOTIFICATION, OTHER_NOTIFICATION].entries()) {
      await sql!`
        INSERT INTO notify.notifications (id, user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key)
        VALUES (
          ${id}, ${USER}, 'bank.margin_call',
          'notify.bank.margin_call.title', 'notify.bank.margin_call.body', 'critical',
          'intafaced.bank.margin_call.created', ${`pg-test-${index}`}
        )
      `;
    }
  });

  it('a second claim while the lease is live is refused as in_flight', async () => {
    const s = store();
    const first = await s.claim(NOTIFICATION, 'email', 3);
    expect(first.claimed).toBe(true);

    const second = await s.claim(NOTIFICATION, 'email', 3);
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.reason).toBe('in_flight');
    // The blocked pass must not spend an attempt, or racing replicas would
    // abandon a margin call between them.
    expect(second.record.attempts).toBe(1);
  });

  it('reclaims once the lease has expired — the crash path', async () => {
    // A one-second lease, then wait it out. This is the branch the interval
    // expression in the upsert decides, so it is the one worth executing.
    const s = new PostgresDeliveryStore(sql!, { leaseMs: 1_000 });
    const first = await s.claim(NOTIFICATION, 'email', 3);
    expect(first.claimed).toBe(true);

    await new Promise((r) => setTimeout(r, 1_200));

    const second = await s.claim(NOTIFICATION, 'email', 3);
    expect(second.claimed).toBe(true);
    if (!second.claimed) return;
    expect(second.attempt).toBe(2);
  });

  it('a settled failure is reclaimable at once, without waiting for the lease', async () => {
    const s = store();
    const first = await s.claim(NOTIFICATION, 'push', 3);
    expect(first.claimed).toBe(true);
    if (!first.claimed) return;

    await s.settle({ id: first.id, attempt: first.attempt, status: 'failed', attempted: true, detail: '503' });

    const second = await s.claim(NOTIFICATION, 'push', 3);
    expect(second.claimed).toBe(true);
  });

  it('an accepted row is terminal — a redelivery never sends twice', async () => {
    const s = store();
    const first = await s.claim(NOTIFICATION, 'sms', 3);
    expect(first.claimed).toBe(true);
    if (!first.claimed) return;

    await s.settle({ id: first.id, attempt: first.attempt, status: 'accepted', attempted: true, reference: 'gw-1' });

    const second = await s.claim(NOTIFICATION, 'sms', 3);
    expect(second.claimed).toBe(false);
    if (second.claimed) return;
    expect(second.reason).toBe('already_accepted');
  });

  it('retires a row that has run out of attempts rather than leaving it pending', async () => {
    const s = new PostgresDeliveryStore(sql!, { leaseMs: 1 });
    for (let i = 0; i < 2; i += 1) {
      const claim = await s.claim(NOTIFICATION, 'email', 2);
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      await s.settle({ id: claim.id, attempt: claim.attempt, status: 'failed', attempted: true, detail: 'boom' });
    }

    const blocked = await s.claim(NOTIFICATION, 'email', 2);
    expect(blocked.claimed).toBe(false);
    if (blocked.claimed) return;
    expect(blocked.reason).toBe('exhausted');
    expect(blocked.record.status).toBe('abandoned');
    expect(blocked.record.refusalCode).toBe('channel.attempts_exhausted');
  });

  it('settle clears the lease, so a failure does not stay owned', async () => {
    const s = store();
    const claim = await s.claim(NOTIFICATION, 'email', 3);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;

    await s.settle({ id: claim.id, attempt: claim.attempt, status: 'failed', attempted: true, detail: '503' });

    const [row] = await s.listForNotification(NOTIFICATION);
    expect(row?.leaseUntil).toBeNull();
  });

  it('a pure refusal leaves attempted_at NULL — nothing was tried', async () => {
    const s = store();
    const claim = await s.claim(NOTIFICATION, 'sms', 3);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;

    await s.settle({ id: claim.id, attempt: claim.attempt, status: 'refused', refusalCode: 'channel.no_target', attempted: false });

    const [row] = await s.listForNotification(NOTIFICATION);
    expect(row).toMatchObject({ status: 'refused', refusalCode: 'channel.no_target' });
    expect(row?.attemptedAt).toBeNull();
    expect(row?.acceptedAt).toBeNull();
  });

  it('the database itself refuses to let a non-accepted row carry an accepted time', async () => {
    // The CHECK from 0002 is what stops a future bug making an undelivered
    // margin call read as delivered. Assert the database, not our discipline.
    const s = store();
    const claim = await s.claim(NOTIFICATION, 'email', 3);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;

    await expect(sql!`UPDATE notify.deliveries SET accepted_at = now() WHERE id = ${claim.id}`).rejects.toThrow();
  });

  it('claims on different notifications do not block each other', async () => {
    const s = store();
    expect((await s.claim(NOTIFICATION, 'email', 3)).claimed).toBe(true);
    expect((await s.claim(OTHER_NOTIFICATION, 'email', 3)).claimed).toBe(true);
  });

  describe('reapExhausted — the row nothing was ever going to come back for', () => {
    it('retires a pending row whose attempts are spent and whose lease is dead', async () => {
      // The parked state: attempts at the ceiling, no owner, and — because the
      // bus has spent `max_deliver` — no further redelivery to run the retire
      // branch in `claim`.
      //
      // The lease is waited out rather than faked, because the statement builds
      // its interval in SQL and rounds UP to whole seconds (`leaseSeconds`), so
      // a sub-second lease is still a one-second lease in the database. Asking
      // for less and waiting milliseconds tests nothing but the local clock.
      const s = new PostgresDeliveryStore(sql!, { leaseMs: 1_000 });
      for (let i = 0; i < 2; i += 1) {
        expect((await s.claim(NOTIFICATION, 'email', 2)).claimed).toBe(true);
        await new Promise((r) => setTimeout(r, 1_200));
      }

      const [before] = await s.listForNotification(NOTIFICATION);
      expect(before).toMatchObject({ status: 'pending', attempts: 2 });

      expect(await s.reapExhausted(2)).toBeGreaterThanOrEqual(1);

      const [after] = await s.listForNotification(NOTIFICATION);
      expect(after).toMatchObject({ status: 'abandoned', refusalCode: 'channel.attempts_exhausted' });
      expect(after?.leaseUntil).toBeNull();
      // The sweep records a failure. The CHECK from 0002 would refuse the row if
      // it ever wrote an accepted time, and it must never try.
      expect(after?.acceptedAt).toBeNull();
    });

    it('does not touch a row whose lease is still live', async () => {
      const s = new PostgresDeliveryStore(sql!, { leaseMs: 60_000 });
      const first = await s.claim(NOTIFICATION, 'push', 1);
      expect(first.claimed).toBe(true);

      // At the attempt ceiling, but someone is mid-send and may yet accept it.
      // Asserted on the row rather than the returned count: the sweep is
      // table-wide by design, so a count is not this test's to own.
      await s.reapExhausted(1);
      expect((await s.listForNotification(NOTIFICATION))[0]?.status).toBe('pending');
    });

    it('leaves a row that still has an attempt left', async () => {
      // Same one-second floor as above: the lease has to be genuinely dead, or
      // this passes for the wrong reason — a live lease would also skip the row.
      const s = new PostgresDeliveryStore(sql!, { leaseMs: 1_000 });
      expect((await s.claim(NOTIFICATION, 'sms', 3)).claimed).toBe(true);
      await new Promise((r) => setTimeout(r, 1_200));

      // Dead lease, but the bus may still redeliver and that send may work.
      // Abandoning here throws away a retry the user is owed.
      await s.reapExhausted(3);
      expect((await s.listForNotification(NOTIFICATION))[0]?.status).toBe('pending');
    });

    it('never rewrites an accepted row', async () => {
      const s = store();
      const claim = await s.claim(NOTIFICATION, 'email', 1);
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      await s.settle({ id: claim.id, attempt: claim.attempt, status: 'accepted', attempted: true, reference: 'gw-1' });

      await s.reapExhausted(1);
      expect((await s.listForNotification(NOTIFICATION))[0]?.status).toBe('accepted');
    });

    it('is idempotent — a second sweep retires nothing', async () => {
      const s = store();
      const claim = await s.claim(NOTIFICATION, 'email', 1);
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      await s.settle({ id: claim.id, attempt: claim.attempt, status: 'failed', attempted: true, detail: '503' });

      expect(await s.reapExhausted(1)).toBeGreaterThanOrEqual(1);
      // Second pass: this row is already terminal, so it is not retired twice.
      // Counted on the row, because the table is shared with the other cases.
      await s.reapExhausted(1);
      expect((await s.listForNotification(NOTIFICATION))[0]).toMatchObject({
        status: 'abandoned',
        attempts: 1,
      });
    });

    it('listRecent is newest-first and capped — operator outcomes view', async () => {
      const s = store();
      const first = await s.claim(NOTIFICATION, 'email', 3);
      expect(first.claimed).toBe(true);
      if (!first.claimed) return;
      await s.settle({
        id: first.id,
        attempt: first.attempt,
        status: 'refused',
        refusalCode: 'channel.not_configured',
        attempted: false,
      });

      const second = await s.claim(OTHER_NOTIFICATION, 'inapp', 3);
      expect(second.claimed).toBe(true);
      if (!second.claimed) return;
      await s.settle({ id: second.id, attempt: second.attempt, status: 'accepted', attempted: true });

      const recent = await s.listRecent(10);
      const ours = recent.filter((r) => r.notificationId === NOTIFICATION || r.notificationId === OTHER_NOTIFICATION);
      expect(ours.length).toBeGreaterThanOrEqual(2);
      const inapp = ours.find((r) => r.channel === 'inapp');
      const email = ours.find((r) => r.channel === 'email');
      expect(inapp).toMatchObject({ status: 'accepted' });
      expect(email).toMatchObject({ status: 'refused', refusalCode: 'channel.not_configured' });
      expect(email?.acceptedAt).toBeNull();
      expect(await s.listRecent(1)).toHaveLength(1);
    });

    it('a noted receipt is not reclaimed for another send, even on the last attempt', async () => {
      const s = new PostgresDeliveryStore(sql!, { leaseMs: 60_000 });
      const first = await s.claim(NOTIFICATION, 'email', 1);
      expect(first.claimed).toBe(true);
      if (!first.claimed) return;
      await s.noteReceipt({ id: first.id, attempt: first.attempt, reference: 'gw-1' });
      await sql!`
        UPDATE notify.deliveries
           SET lease_until = now() - interval '1 hour',
               updated_at = now() - interval '1 hour'
         WHERE id = ${first.id}
      `;

      const second = await s.claim(NOTIFICATION, 'email', 1);
      expect(second.claimed).toBe(false);
      if (second.claimed) return;
      expect(second.reason).toBe('receipt_pending');
      expect(second.record.attempts).toBe(1);
      expect(second.record.status).toBe('pending');
      expect(second.record.reference).toBe('gw-1');
      expect(second.record.acceptedAt).toBeNull();

      await s.reapExhausted(1, { stuckGraceMs: 1_000 });
      const [row] = await s.listForNotification(NOTIFICATION);
      expect(row?.status).toBe('pending');
      expect(row?.reference).toBe('gw-1');
      expect(row?.refusalCode).toBeNull();
    });

    it('a noted receipt with no transport handle stays null', async () => {
      const s = store();
      const first = await s.claim(NOTIFICATION, 'sms', 3);
      expect(first.claimed).toBe(true);
      if (!first.claimed) return;
      await s.noteReceipt({ id: first.id, attempt: first.attempt, reference: null });

      const second = await s.claim(NOTIFICATION, 'sms', 3);
      expect(second.claimed).toBe(false);
      if (second.claimed) return;
      expect(second.reason).toBe('receipt_pending');
      expect(second.record.reference).toBeNull();
      expect(second.record.attemptedAt).not.toBeNull();
      expect(second.record.acceptedAt).toBeNull();
    });

    it('arm 2 on Postgres names delivery_stuck when attempts are still below max', async () => {
      // THE in_flight hole, executed against real SQL: one claim (attempts=1),
      // lease dies, stuckGrace short so we do not wait 150s. Must not stamp
      // attempts_exhausted for a budget that was never spent.
      //
      // Postgres rounds grace up to whole seconds (`graceSeconds = ceil(ms/1000)`).
      // Wait lease (1s) + grace (1s) + slack so the row is actually past the
      // dead-lease window — waiting only ~lease leaves arm 2 with zero rows.
      const s = new PostgresDeliveryStore(sql!, { leaseMs: 1_000 });
      expect((await s.claim(NOTIFICATION, 'email', 3)).claimed).toBe(true);
      await new Promise((r) => setTimeout(r, 2_500));

      const [before] = await s.listForNotification(NOTIFICATION);
      expect(before).toMatchObject({ status: 'pending', attempts: 1 });

      expect(await s.reapExhausted(3, { stuckGraceMs: 1_000 })).toBeGreaterThanOrEqual(1);

      const [after] = await s.listForNotification(NOTIFICATION);
      expect(after).toMatchObject({
        status: 'abandoned',
        attempts: 1,
        refusalCode: 'channel.delivery_stuck',
      });
      expect(after?.acceptedAt).toBeNull();
    });
  });
});

describe.skipIf(!available)('PostgresTargetStore — verified and unverified are different questions', () => {
  const store = () => new PostgresTargetStore(sql!);

  beforeEach(async () => {
    await sql!`DELETE FROM notify.channel_targets WHERE user_id = ${USER}`;
  });

  it('an unconfirmed address is absent from verified() and named by unverifiedChannels()', async () => {
    const s = store();
    await s.upsert({
      userId: USER,
      channel: 'sms',
      address: '+447700900000',
      locale: 'en',
      verifyTokenHash: 'y'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await s.verified(USER)).toEqual([]);
    expect(await s.unverifiedChannels(USER)).toEqual(['sms']);
  });

  it('confirming moves it across, and it is named by neither question twice', async () => {
    const s = store();
    await s.upsert({
      userId: USER,
      channel: 'email',
      address: 'someone@example.com',
      locale: 'en',
      verifyTokenHash: 'z'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await s.markVerified(USER, 'email', 'z'.repeat(64), new Date())).toBe(true);

    expect((await s.verified(USER)).map((t) => t.channel)).toEqual(['email']);
    expect(await s.unverifiedChannels(USER)).toEqual([]);
  });
});

describe.skipIf(!available)('PostgresDeliveryStore.wait — a mailed copy owed with no sender set (SP-csat-01)', () => {
  const store = () => new PostgresDeliveryStore(sql!, { leaseMs: 60_000 });

  beforeEach(async () => {
    await sql!`DELETE FROM notify.deliveries WHERE notification_id = ${NOTIFICATION}`;
    await sql!`DELETE FROM notify.notifications WHERE id = ${NOTIFICATION}`;
    await sql!`
      INSERT INTO notify.notifications (id, user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key)
      VALUES (
        ${NOTIFICATION}, ${USER}, 'support.rate_request',
        'notify.support.rate_request.title', 'notify.support.rate_request.body', 'info',
        'intafaced.support.ticket.resolved', 'pg-test-wait'
      )
    `;
  });

  it('writes one pending row named vendor.email that nothing claimed, and a second wait changes nothing', async () => {
    const s = store();
    const first = await s.wait(NOTIFICATION, 'email', 'vendor.email');
    expect(first).toMatchObject({
      status: 'pending',
      attempts: 0,
      refusalCode: 'vendor.email',
      attemptedAt: null,
      acceptedAt: null,
      leaseUntil: null,
    });
    const again = await s.wait(NOTIFICATION, 'email', 'vendor.email');
    expect(again.id).toBe(first.id);
    expect(await s.listForNotification(NOTIFICATION)).toHaveLength(1);
  });

  it('is never reaped as stuck or exhausted, however old', async () => {
    const s = store();
    await s.wait(NOTIFICATION, 'email', 'vendor.email');
    await sql!`UPDATE notify.deliveries SET updated_at = now() - interval '1 day' WHERE notification_id = ${NOTIFICATION}`;
    await s.reapExhausted(1, { stuckGraceMs: 1_000 });
    const [row] = await s.listForNotification(NOTIFICATION);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, refusalCode: 'vendor.email' });
  });

  it('leaves a row a claim already made as it stands', async () => {
    const s = store();
    expect((await s.claim(NOTIFICATION, 'email', 3)).claimed).toBe(true);
    const row = await s.wait(NOTIFICATION, 'email', 'vendor.email');
    expect(row).toMatchObject({ status: 'pending', attempts: 1, refusalCode: null });
  });
});
