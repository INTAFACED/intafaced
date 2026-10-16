import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { GuestNotificationService } from './service.js';
import { EmailChannel } from '../channels/adapters.js';

const request = () => ({
  businessKey: `acknowledgement:${randomUUID()}`,
  contactId: randomUUID(),
  submissionId: randomUUID(),
  recipientEmail: 'prospect@example.com',
  message: { kind: 'enquiry_acknowledgement' as const },
});
const servers: Server[] = [];
async function gateway(answer: (res: ServerResponse) => void) {
  const messages: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      messages.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      keys.push(String(req.headers['idempotency-key']));
      answer(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/send`;
  return { messages, keys, email: new EmailChannel({ url, token: 'fixture-gateway-token-at-least-16', timeoutMs: 2000 }) };
}

describe('Guest notification durable boundary (isolated PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'notify',
      migrations: [readFileSync(new URL('../../drizzle/0009_guest_notifications.sql', import.meta.url), 'utf8')],
    });
  }, 30_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  beforeEach(async () => {
    await db.truncateAll();
  });
  it('keeps a single original business request across restart and refuses changed recipients', async () => {
    const input = request();
    const first = await new GuestNotificationService(db.sql, null).send(input);
    expect(first).toMatchObject({
      businessKey: input.businessKey,
      status: 'refused',
      code: 'guest.notification_unconfigured',
      attemptedAt: null,
      acceptedAt: null,
    });
    const restarted = new GuestNotificationService(db.sql, null);
    expect(await restarted.send(input)).toEqual(first);
    expect(await restarted.get({ businessKey: input.businessKey })).toEqual(first);
    await expect(restarted.send({ ...input, recipientEmail: 'other@example.com' })).rejects.toMatchObject({
      code: 'guest.request_conflict',
    });
  });
  it('accepts one contact acknowledgement on the actual socket and never claims questionnaire completion or delivery', async () => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{"id":"gateway-accepted-1"}');
    });
    const input = request();
    const service = new GuestNotificationService(db.sql, wire.email);
    const accepted = await service.send(input);
    expect(accepted).toMatchObject({ status: 'accepted', code: null, reference: 'gateway-accepted-1' });
    expect(accepted.attemptedAt).not.toBeNull();
    expect(accepted.acceptedAt).not.toBeNull();
    expect(wire.messages).toEqual([
      expect.objectContaining({
        to: input.recipientEmail,
        href: null,
        subject: 'Your INTAFACED enquiry',
        text: 'Thanks for your interest in INTAFACED. We’ve received your contact details. The team reviews enquiries before arranging calls.',
      }),
    ]);
    expect(await new GuestNotificationService(db.sql, wire.email).send(input)).toEqual(accepted);
    expect(wire.messages).toHaveLength(1);
    expect(wire.keys).toEqual([expect.stringMatching(/^guest-email-v1:[a-f0-9]{64}$/)]);
    expect(wire.keys[0]).not.toContain(accepted.notificationId);
    expect(wire.keys[0]).not.toContain(input.businessKey);
    expect(accepted).not.toHaveProperty('deliveredAt');
  });
  it('erases prospect payload durably and blocks future enqueue, while replaying the original erase receipt', async () => {
    const input = request();
    const service = new GuestNotificationService(db.sql, null);
    await service.send(input);
    const erase = { requestId: randomUUID(), submissionId: input.submissionId };
    const erased = await service.eraseSubmission(erase);
    expect(erased).toMatchObject({ ...erase, erasedCount: 1 });
    expect(await new GuestNotificationService(db.sql, null).eraseSubmission(erase)).toEqual(erased);
    await expect(service.send({ ...input, businessKey: `new:${randomUUID()}` })).rejects.toMatchObject({ code: 'guest.submission_erased' });
    expect(await service.get({ businessKey: input.businessKey })).toMatchObject({ status: 'refused', code: 'guest.submission_erased' });
  });
  it('gateway acceptance with a lost response stays unresolved across restart and is never blindly resent', async () => {
    const wire = await gateway((res) => res.destroy());
    const input = request();
    const first = await new GuestNotificationService(db.sql, wire.email).send(input);
    expect(first).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown', acceptedAt: null, reference: null });
    expect(await new GuestNotificationService(db.sql, wire.email).send(input)).toEqual(first);
    expect(wire.messages).toHaveLength(1);
  });
  it('a late gateway reply cannot promote an already unresolved outcome', async () => {
    const wire = await gateway((res) => {
      setTimeout(() => {
        res.writeHead(202);
        res.end('{"id":"too-late"}');
      }, 60);
    });
    const input = request();
    const service = new GuestNotificationService(db.sql, wire.email, { timeoutMs: 10 });
    const first = await service.send(input);
    expect(first).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await service.get({ businessKey: input.businessKey })).toEqual(first);
    expect(wire.messages).toHaveLength(1);
  });
  it.each([0, -3600000])(
    'a delayed committed claim cannot first hand off after erase, including wall-clock shift %i',
    async (wallShift) => {
      const wire = await gateway((res) => {
        res.writeHead(202);
        res.end('{}');
      });
      let committed!: () => void, release!: () => void;
      const claimCommitted = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const delayedReturn = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedSql = new Proxy(db.sql, {
        get(target, property, receiver) {
          if (property === 'begin')
            return async (...args: Parameters<typeof db.sql.begin>) => {
              const result = await target.begin(...args); // Actual PostgreSQL COMMIT, not a fabricated claim.
              committed();
              await delayedReturn;
              return result;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const input = request();
      const pending = new GuestNotificationService(delayedSql, wire.email, { timeoutMs: 100, leaseMs: 150 }).send(input);
      try {
        await claimCommitted;
        expect(
          (await db.sql`SELECT status,payload FROM notify.guest_notifications WHERE business_key=${input.businessKey}`)[0],
        ).toMatchObject({ status: 'attempting', payload: input });
        await db.sql`SELECT pg_sleep(0.18)`;
        const other = new GuestNotificationService(db.sql, wire.email);
        const erased = await other.eraseSubmission({ requestId: randomUUID(), submissionId: input.submissionId });
        expect(erased.erasedCount).toBe(1);
        if (wallShift) vi.spyOn(Date, 'now').mockReturnValue(Date.now() + wallShift);
        release();
        const result = await pending;
        expect(result).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown', reference: null, acceptedAt: null });
        expect(wire.messages).toHaveLength(0);
        expect(await other.get({ businessKey: input.businessKey })).toEqual(result);
        expect(
          (await db.sql`SELECT payload,erased_at FROM notify.guest_notifications WHERE business_key=${input.businessKey}`)[0],
        ).toMatchObject({ payload: null, erased_at: expect.any(Date) });
        expect(
          (await db.sql`SELECT submission_id FROM notify.guest_erased_submissions WHERE submission_id=${input.submissionId}`)[0],
        ).toMatchObject({ submission_id: input.submissionId });
      } finally {
        release();
        await pending.catch(() => undefined);
        vi.restoreAllMocks();
      }
    },
  );
  it('a still-live claim with insufficient remaining delivery budget never hands off', async () => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{}');
    });
    let sawLiveLease = false;
    const delayedSql = new Proxy(db.sql, {
      get(target, property, receiver) {
        if (property === 'begin')
          return async (...args: Parameters<typeof db.sql.begin>) => {
            const result = await target.begin(...args);
            await db.sql`SELECT pg_sleep(0.2)`;
            sawLiveLease =
              (await db.sql`SELECT 1 FROM notify.guest_notifications WHERE status='attempting' AND lease_until>clock_timestamp()`)
                .length === 1;
            return result;
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await new GuestNotificationService(delayedSql, wire.email, { timeoutMs: 900, leaseMs: 1000 }).send(request());
    expect(sawLiveLease).toBe(true);
    expect(result).toMatchObject({ status: 'unresolved', code: 'guest.acceptance_unknown', acceptedAt: null, reference: null });
    expect(wire.messages).toHaveLength(0);
  });
  it('two concurrent workers share one durable claim and erasure refuses during the active attempt', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wire = await gateway((res) => {
      release = () => {
        res.writeHead(202);
        res.end('{}');
      };
      entered();
    });
    const input = request();
    const service = new GuestNotificationService(db.sql, wire.email);
    const first = service.send(input);
    await started;
    expect(await new GuestNotificationService(db.sql, wire.email).send(input)).toMatchObject({ status: 'attempting' });
    await expect(service.eraseSubmission({ requestId: randomUUID(), submissionId: input.submissionId })).rejects.toMatchObject({
      code: 'guest.delivery_in_progress',
    });
    release();
    expect(await first).toMatchObject({ status: 'accepted' });
    expect(wire.messages).toHaveLength(1);
  });
  it('a known pre-attempt configuration refusal can resume the same original request after wiring', async () => {
    const input = request();
    await new GuestNotificationService(db.sql, null).send(input);
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{}');
    });
    expect(await new GuestNotificationService(db.sql, wire.email).send(input)).toMatchObject({ status: 'accepted' });
    expect(wire.messages).toHaveLength(1);
  });
  it('PostgreSQL prevents mutation of original recipient, removal, or rewriting an attempted terminal result', async () => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{}');
    });
    const input = request();
    const accepted = await new GuestNotificationService(db.sql, wire.email).send(input);
    expect(accepted.status).toBe('accepted');
    await expect(db.sql`UPDATE notify.guest_notifications
      SET payload = jsonb_set(payload, '{recipientEmail}', '"other@example.com"') WHERE id = ${accepted.notificationId}`).rejects.toMatchObject(
      { code: '23514' },
    );
    await expect(db.sql`DELETE FROM notify.guest_notifications WHERE id = ${accepted.notificationId}`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(db.sql`UPDATE notify.guest_notifications SET status = 'unresolved', code = 'guest.acceptance_unknown',
      accepted_at = NULL WHERE id = ${accepted.notificationId}`).rejects.toMatchObject({ code: '23514' });
  });
  it('shares a durable recipient budget across concurrent replicas without burning retries', async () => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{}');
    });
    const options = { addressMaxPerWindow: 1, addressWindowMs: 900000 };
    const inputs = [request(), request()];
    const results = await Promise.all(inputs.map((input) => new GuestNotificationService(db.sql, wire.email, options).send(input)));
    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'refused']);
    expect(results.find((result) => result.status === 'refused')).toMatchObject({ code: 'guest.address_rate_limited', attemptedAt: null });
    await Promise.all(inputs.map((input) => new GuestNotificationService(db.sql, wire.email, options).send(input)));
    expect(wire.messages).toHaveLength(1);
  });
  it('gateway acceptance followed by a SQL-write failure expires to unresolved after restart, with no second send', async () => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{"id":"accepted-before-crash"}');
    });
    await db.sql.unsafe(`CREATE FUNCTION notify.inject_guest_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'accepted' THEN RAISE EXCEPTION 'injected acceptance write crash'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER inject_guest_crash BEFORE UPDATE ON notify.guest_notifications FOR EACH ROW EXECUTE FUNCTION notify.inject_guest_crash();`);
    try {
      const input = request();
      // Delivery deadline stays 100ms. The old lease was only 20ms longer, so a
      // claim that has already committed and then returns after that slack
      // stores acceptance_unknown and never reaches the gateway. Hold that
      // return for 50ms and give the lease room the hold cannot consume.
      // Lease expiry is moved in SQL; the test does not sleep the lease out.
      const options = { timeoutMs: 100, leaseMs: 30_000 };
      const slowSql = new Proxy(db.sql, {
        get(target, property, receiver) {
          if (property !== 'begin') return Reflect.get(target, property, receiver);
          const begin = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            const result = await begin.apply(target, args);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return result;
          };
        },
      });
      await expect(new GuestNotificationService(slowSql as typeof db.sql, wire.email, options).send(input)).rejects.toMatchObject({
        code: 'guest.storage_unavailable',
      });
      expect(wire.messages).toHaveLength(1);
      const [held] =
        await db.sql`SELECT status, code FROM notify.guest_notifications WHERE business_key = ${input.businessKey}`;
      expect(held).toMatchObject({ status: 'attempting', code: null });
      expect(await new GuestNotificationService(db.sql, wire.email, options).send(input)).toMatchObject({ status: 'attempting' });
      await db.sql`UPDATE notify.guest_notifications SET lease_until = clock_timestamp() - interval '1 millisecond' WHERE business_key = ${input.businessKey}`;
      expect(await new GuestNotificationService(db.sql, wire.email, options).send(input)).toMatchObject({
        status: 'unresolved',
        code: 'guest.acceptance_unknown',
      });
      expect(wire.messages).toHaveLength(1);
    } finally {
      await db.sql.unsafe('DROP TRIGGER inject_guest_crash ON notify.guest_notifications; DROP FUNCTION notify.inject_guest_crash()');
    }
  });
  it.each(['accepted', 'unresolved'] as const)('%s erasure purges recipient and staff text without rewriting outcomes', async (outcome) => {
    const wire = await gateway((res) => {
      if (outcome === 'unresolved') return res.destroy();
      res.writeHead(202);
      res.end('{"id":"opaque-acceptance"}');
    });
    const input = {
      ...request(),
      message: { kind: 'information_request' as const, activityId: randomUUID(), staffText: 'Private founder request to remove.' },
    };
    const service = new GuestNotificationService(db.sql, wire.email);
    const accepted = await service.send(input);
    expect(accepted.status).toBe(outcome);
    await service.eraseSubmission({ requestId: randomUUID(), submissionId: input.submissionId });
    expect(await service.get({ businessKey: input.businessKey })).toEqual({ ...accepted, reference: null });
    // Privacy verification inspects owned durable storage: a receipt alone
    // cannot prove the confidential original was actually purged.
    const [stored] =
      await db.sql`SELECT payload, fingerprint, reference, erased_at FROM notify.guest_notifications WHERE id = ${accepted.notificationId}`;
    expect(stored!.payload).toBeNull();
    expect(stored!.reference).toBeNull();
    expect(stored!.erased_at).not.toBeNull();
    await expect(service.eraseSubmission({ requestId: randomUUID(), submissionId: input.submissionId })).resolves.toMatchObject({
      erasedCount: 0,
    });
  });
  it.each(['call_invitation', 'follow_up'] as const)('sends a fixed %s wrapper around an attributed saved staff action', async (kind) => {
    const wire = await gateway((res) => {
      res.writeHead(202);
      res.end('{}');
    });
    const input = { ...request(), message: { kind, activityId: randomUUID(), staffText: 'Please let us know what works for you.' } };
    expect(await new GuestNotificationService(db.sql, wire.email).send(input)).toMatchObject({ status: 'accepted' });
    expect(wire.messages[0]).toMatchObject({ to: input.recipientEmail, kind, href: null });
    expect(wire.messages[0]!.text).toContain(input.message.staffText);
    expect(wire.messages[0]).not.toHaveProperty('html');
  });
  it('a permanent gateway rejection records no acceptance and never retries or retains its response body', async () => {
    const wire = await gateway((res) => {
      res.writeHead(403);
      res.end('Private prospect content and token=secret');
    });
    const input = request();
    const service = new GuestNotificationService(db.sql, wire.email);
    const first = await service.send(input);
    expect(first).toMatchObject({ status: 'refused', code: 'guest.gateway_refused', acceptedAt: null, reference: null });
    expect(await service.send(input)).toEqual(first);
    expect(wire.messages).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('token=secret');
  });
});
