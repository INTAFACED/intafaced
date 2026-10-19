// Agreed seam: actual EmailChannel HTTP -> independent relay SQL -> mailbox HTTP.
// The mailbox is a loopback fixture, not a live send or recipient-arrival proof.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { EmailChannel } from '../channels/adapters.js';
import { GuestNotificationService } from '../guests/service.js';
import { buildMailboxRelay } from './relay.js';

const run = promisify(execFile);
const credential = 'synthetic-relay-credential-at-least-32-characters';
const sendToken = 'synthetic-mailbox-credential-different-from-relay';
const guestMigration = readFileSync(new URL('../../drizzle/0009_guest_notifications.sql', import.meta.url), 'utf8');
const resources: Array<() => Promise<unknown>> = [];
async function upstream(handle?: (res: ServerResponse) => void | Promise<void>) {
  const messages: unknown[] = [];
  const authorization: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    messages.push(JSON.parse(body));
    authorization.push(req.headers.authorization);
    if (handle) await handle(res);
    else res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`;
  // Production configuration requires HTTPS; only the test transport maps it
  // to an actual loopback HTTP fixture. Redirect policy/signal/headers survive.
  const fetchImpl: typeof fetch = (_url, init) => fetch(url, init);
  return { messages, authorization, fetchImpl, url };
}
async function relay(db: TestDatabase, fetchImpl: typeof fetch, timeoutMs = 1000) {
  const app = buildMailboxRelay({ sql: db.sql, credential, sendUrl: 'https://mailbox.fixture/send', sendToken, timeoutMs, fetchImpl });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  resources.push(() => app.close());
  return { app, url, email: new EmailChannel({ url: url + '/send', token: credential, timeoutMs: 2000 }) };
}
function envelope() {
  return {
    channel: 'email',
    notificationId: randomUUID(),
    to: 'local-proof@example.invalid',
    locale: 'en',
    severity: 'info',
    kind: 'staff_follow_up',
    subject: 'Synthetic subject',
    text: 'Synthetic private message',
    href: null,
    titleKey: 'notify.outreach.staff_follow_up.title',
    bodyKey: 'notify.outreach.staff_follow_up.body',
  };
}
const request = (url: string, key: string, body: ReturnType<typeof envelope>, signal?: AbortSignal) =>
  fetch(url + '/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'idempotency-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function settled(db: TestDatabase, status: string) {
  await expect
    .poll(async () => (await db.sql`SELECT status FROM notify.mailbox_relay_receipts`)[0]?.status, { timeout: 3000 })
    .toBe(status);
}

describe('independent mailbox receipt restore boundary (actual SQL + HTTP)', () => {
  let first: TestDatabase, restored: TestDatabase, independent: TestDatabase;
  beforeAll(async () => {
    first = await createTestDatabase({ service: 'notify', migrations: [guestMigration] });
    restored = await createTestDatabase({ service: 'notify' });
    independent = await createTestDatabase({
      service: 'notify',
      migrations: [readFileSync(new URL('../../drizzle/gateway/0000_mailbox_relay.sql', import.meta.url), 'utf8')],
    });
  }, 30_000);
  beforeEach(async () => {
    await independent.truncateAll();
  });
  afterEach(async () => {
    for (const close of resources.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    for (const db of [first, restored, independent]) await db?.drop();
  }, 30_000);
  it('replays one immutable business request after actual old guest backup restore without another mailbox attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'intafaced-mail-relay-restore-'));
    try {
      const archive = join(dir, 'before-enqueue.dump');
      await run(process.env.PG_DUMP_BIN ?? 'pg_dump', ['--format=custom', '--schema=notify', '--file', archive, '--dbname', first.url]);
      const wire = await upstream();
      const gateway = await relay(independent, wire.fetchImpl);
      const input = {
        businessKey: `acknowledgement:${randomUUID()}`,
        contactId: randomUUID(),
        submissionId: randomUUID(),
        recipientEmail: 'local-proof@example.invalid',
        message: { kind: 'enquiry_acknowledgement' as const },
      };
      const original = await new GuestNotificationService(first.sql, gateway.email, { timeoutMs: 2500 }).send(input);
      expect(original.status).toBe('accepted');
      await run(process.env.PG_RESTORE_BIN ?? 'pg_restore', ['--clean', '--if-exists', '--dbname', restored.url, archive]);
      const recovered = await new GuestNotificationService(restored.sql, gateway.email, { timeoutMs: 2500 }).send(input);
      expect(recovered.notificationId).not.toBe(original.notificationId);
      expect(recovered).toMatchObject({ status: 'accepted', reference: original.reference });
      expect(original.reference).toMatch(/^relay:[0-9a-f-]{36}$/);
      expect(wire.messages).toHaveLength(1);
      expect(wire.messages[0]).toEqual({
        to: [input.recipientEmail],
        displayName: 'INTAFACED',
        subject: 'Your INTAFACED enquiry',
        text: 'Thanks for your interest in INTAFACED. We’ve received your contact details. The team reviews enquiries before arranging calls.',
      });
      expect(wire.authorization).toEqual([`Bearer ${sendToken}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('serializes simultaneous attempts, rejects changed delivery, and stores only opaque receipts', async () => {
    const entered = gate(),
      release = gate();
    const wire = await upstream(async (res) => {
      entered.release();
      await release.promise;
      res.writeHead(204).end();
    });
    const gateway = await relay(independent, wire.fetchImpl);
    const key = `synthetic-claim:${randomUUID()}`,
      body = envelope();
    const firstAttempt = request(gateway.url, key, body);
    await entered.promise;
    const concurrent = await request(gateway.url, key, { ...body, notificationId: randomUUID() });
    expect(concurrent.status).toBe(503);
    expect(await concurrent.json()).toEqual({ code: 'notify.relay.acceptance_unknown' });
    release.release();
    const firstResponse = await firstAttempt;
    expect(firstResponse.status).toBe(200);
    const accepted = await firstResponse.json();
    const duplicate = await request(gateway.url, key, { ...body, notificationId: randomUUID(), locale: 'fr', severity: 'critical' });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(accepted);
    const changed = await request(gateway.url, key, { ...body, text: 'Different private message' });
    expect(changed.status).toBe(409);
    expect(wire.messages).toHaveLength(1);
    const rows = await independent.sql`SELECT * FROM notify.mailbox_relay_receipts`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'attempted_at',
      'deadline_at',
      'envelope_hash',
      'gateway_id',
      'key_hash',
      'settled_at',
      'status',
      'upstream_status',
    ]);
    const stored = JSON.stringify(rows);
    for (const value of [key, body.to, body.subject, body.text, body.notificationId, credential, sendToken])
      expect(stored).not.toContain(value);
    expect(rows[0]).toMatchObject({
      key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      envelope_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'accepted',
    });
    await expect(independent.sql`UPDATE notify.mailbox_relay_receipts SET status='attempting',settled_at=NULL`).rejects.toThrow();
    await expect(independent.sql`DELETE FROM notify.mailbox_relay_receipts`).rejects.toThrow();
  });
  it('recovers an accepted receipt after the caller loses its HTTP response without another send', async () => {
    const entered = gate(),
      release = gate();
    const wire = await upstream(async (res) => {
      entered.release();
      await release.promise;
      res.writeHead(204).end();
    });
    const gateway = await relay(independent, wire.fetchImpl);
    const key = `synthetic-lost:${randomUUID()}`,
      body = envelope(),
      abort = new AbortController();
    const lostResponse = request(gateway.url, key, body, abort.signal).catch(() => null);
    await entered.promise;
    abort.abort();
    expect(await lostResponse).toBeNull();
    release.release();
    await settled(independent, 'accepted');
    const restarted = await relay(independent, wire.fetchImpl);
    const recovered = await request(restarted.url, key, { ...body, notificationId: randomUUID() });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      id: `relay:${(await independent.sql`SELECT gateway_id FROM notify.mailbox_relay_receipts`)[0]!.gateway_id}`,
    });
    expect(wire.messages).toHaveLength(1);
  });
  it.each(['lost upstream reply', 'upstream timeout', 'unexpected successful status'] as const)(
    'never repeats an unknown attempt after restart: %s',
    async (scenario) => {
      const wire = await upstream((res) => {
        if (scenario === 'lost upstream reply') res.destroy();
        if (scenario === 'unexpected successful status') res.writeHead(200).end('not a confirmed 204');
      });
      // The budget covers the receipt claim as well as the send. 150 ms let a slow claim on a busy runner spend it all, so the
      // relay (correctly) never sent and the mailbox saw nothing; 1 s leaves room and still expires for the hanging reply.
      const gateway = await relay(independent, wire.fetchImpl);
      const key = `synthetic-unknown:${randomUUID()}`,
        body = envelope();
      const unknown = await request(gateway.url, key, body);
      expect(unknown.status).toBe(503);
      expect(await unknown.json()).toEqual({ code: 'notify.relay.acceptance_unknown' });
      await settled(independent, 'unknown');
      const restarted = await relay(independent, wire.fetchImpl);
      expect((await request(restarted.url, key, { ...body, notificationId: randomUUID() })).status).toBe(503);
      expect(wire.messages).toHaveLength(1);
    },
  );
  it('stores unknown when a non-204 answer arrives after the local deadline and does not send again', async () => {
    const real = performance.now.bind(performance);
    let extra = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + extra);
    try {
      const wire = await upstream((res) => {
        // The reply is already on the wire. The local budget is exhausted before
        // the handler classifies it, which is the slow-runner shape of the 150ms case.
        extra = 2_000;
        res.writeHead(200).end('not a confirmed 204');
      });
      const gateway = await relay(independent, wire.fetchImpl, 1_000);
      const key = `synthetic-deadline-200:${randomUUID()}`,
        body = envelope();
      const unknown = await request(gateway.url, key, body);
      expect(unknown.status).toBe(503);
      expect(await unknown.json()).toEqual({ code: 'notify.relay.acceptance_unknown' });
      extra = 0;
      expect((await independent.sql`SELECT status FROM notify.mailbox_relay_receipts`)[0]?.status).toBe('unknown');
      const restarted = await relay(independent, wire.fetchImpl, 1_000);
      expect((await request(restarted.url, key, { ...body, notificationId: randomUUID() })).status).toBe(503);
      expect(wire.messages).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('keeps a persisted crash claim unknown and never reclaims it', async () => {
    const wire = await upstream(),
      gateway = await relay(independent, wire.fetchImpl);
    const key = `synthetic-crash:${randomUUID()}`,
      body = envelope();
    // A terminated process can leave this exact pre-network state. Recreate
    // its persisted fingerprint and expired claim without a running process.
    expect((await request(gateway.url, key, body)).status).toBe(200);
    const [prior] = await independent.sql`SELECT * FROM notify.mailbox_relay_receipts`;
    await independent.sql`TRUNCATE notify.mailbox_relay_receipts`;
    await independent.sql`INSERT INTO notify.mailbox_relay_receipts (key_hash,envelope_hash,gateway_id,status,attempted_at,deadline_at)
      VALUES (${prior!.key_hash},${prior!.envelope_hash},${prior!.gateway_id},'attempting',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`;
    const restarted = await relay(independent, wire.fetchImpl);
    expect((await request(restarted.url, key, body)).status).toBe(503);
    expect(wire.messages).toHaveLength(1);
  });
  it.each([401, 403, 422])('durably refuses upstream %s without retaining or exposing its body', async (status) => {
    const sensitive = `${sendToken} local-proof@example.invalid Synthetic private message`;
    const wire = await upstream((res) => {
      res.writeHead(status).end(sensitive);
    });
    const gateway = await relay(independent, wire.fetchImpl);
    const key = `synthetic-refused:${randomUUID()}`,
      body = envelope();
    const refused = await request(gateway.url, key, body);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ code: 'notify.relay.upstream_refused' });
    const restarted = await relay(independent, wire.fetchImpl);
    expect((await request(restarted.url, key, body)).status).toBe(status);
    expect(wire.messages).toHaveLength(1);
    expect(JSON.stringify(await independent.sql`SELECT * FROM notify.mailbox_relay_receipts`)).not.toContain(sensitive);
  });
  it('refuses redirects without forwarding the upstream bearer credential', async () => {
    const destination = await upstream();
    const redirect = await upstream((res) => {
      res.writeHead(302, { location: destination.url }).end();
    });
    // Map only the initial HTTPS endpoint. Redirect policy must prevent every
    // second fetch, regardless of whether the target would be reachable.
    const gateway = await relay(independent, redirect.fetchImpl);
    const key = `synthetic-redirect:${randomUUID()}`;
    expect((await request(gateway.url, key, envelope())).status).toBe(503);
    expect(redirect.messages).toHaveLength(1);
    expect(destination.messages).toHaveLength(0);
    expect((await independent.sql`SELECT status FROM notify.mailbox_relay_receipts`)[0]!.status).not.toBe('accepted');
  });
  it('rejects unauthorized, unbounded and non-strict requests before creating an attempt', async () => {
    const wire = await upstream(),
      gateway = await relay(independent, wire.fetchImpl);
    const body = envelope(),
      key = `synthetic-input:${randomUUID()}`;
    const post = (authorization: string, input: unknown, idempotencyKey = key) =>
      fetch(gateway.url + '/send', {
        method: 'POST',
        headers: { authorization, 'idempotency-key': idempotencyKey, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    expect((await post('Bearer incorrect', body)).status).toBe(401);
    expect((await post(`Bearer ${credential}`, { ...body, extra: 'not allowed' })).status).toBe(400);
    expect((await post(`Bearer ${credential}`, body, 'short')).status).toBe(400);
    expect((await post(`Bearer ${credential}`, { ...body, text: 'x'.repeat(40_000) })).status).toBe(413);
    expect((await independent.sql`SELECT count(*)::int AS count FROM notify.mailbox_relay_receipts`)[0]!.count).toBe(0);
    expect(wire.messages).toHaveLength(0);
  });
  it.each(['failed', 'late'] as const)('cannot manufacture acceptance after a %s SQL receipt', async (mode) => {
    await independent.sql.unsafe(`CREATE FUNCTION notify.test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='accepted' THEN ${mode === 'failed' ? "RAISE EXCEPTION 'synthetic receipt failure';" : 'PERFORM pg_sleep(0.3);'} END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_test_receipt_failure BEFORE UPDATE ON notify.mailbox_relay_receipts FOR EACH ROW EXECUTE FUNCTION notify.test_receipt_failure();`);
    try {
      const wire = await upstream(),
        gateway = await relay(independent, wire.fetchImpl, mode === 'late' ? 150 : 1000);
      const key = `synthetic-sql:${randomUUID()}`,
        body = envelope();
      expect((await request(gateway.url, key, body)).status).toBe(503);
      await settled(independent, 'unknown');
      const restarted = await relay(independent, wire.fetchImpl);
      expect((await request(restarted.url, key, body)).status).toBe(503);
      expect(wire.messages).toHaveLength(1);
      expect((await independent.sql`SELECT status FROM notify.mailbox_relay_receipts`)[0]!.status).not.toBe('accepted');
    } finally {
      await independent.sql`DROP TRIGGER zz_test_receipt_failure ON notify.mailbox_relay_receipts`;
      await independent.sql`DROP FUNCTION notify.test_receipt_failure()`;
    }
  });
});
