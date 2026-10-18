import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';

const boundedToken = z
  .string()
  .min(32)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const relaySettingsSchema = z
  .object({
    credential: boundedToken,
    sendUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
      }),
    sendToken: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/),
    timeoutMs: z.number().int().min(100).max(10000),
  })
  .strict()
  .refine((settings) => settings.credential !== settings.sendToken);

const opaque = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const envelopeSchema = z
  .object({
    channel: z.literal('email'),
    notificationId: opaque,
    to: z.string().email().max(320),
    locale: z.string().min(2).max(32),
    severity: z.enum(['info', 'action', 'critical']),
    kind: opaque,
    subject: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\r\n\0]/.test(value)),
    text: z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => !value.includes('\0')),
    href: z.string().max(2048).nullable(),
    titleKey: opaque,
    bodyKey: opaque,
  })
  .strict();
type Receipt = {
  key_hash: string;
  envelope_hash: string;
  gateway_id: string;
  status: 'attempting' | 'accepted' | 'refused' | 'unknown';
  upstream_status: number | null;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secretDigest = (value: string) => createHash('sha256').update(value).digest();
class Deadline extends Error {}

/** SQL owns the one-attempt claim; neither an HTTP retry nor a restored guest
 * notification UUID grants a new upstream attempt. No lock spans network IO. */
export function buildMailboxRelay(options: {
  sql: Sql;
  credential: string;
  sendUrl: string;
  sendToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}) {
  const parsed = relaySettingsSchema.safeParse({
    credential: options.credential,
    sendUrl: options.sendUrl,
    sendToken: options.sendToken,
    timeoutMs: options.timeoutMs,
  });
  if (!parsed.success) throw new Error('notify.relay.configuration_invalid');
  const config = parsed.data,
    sql = options.sql,
    fetchImpl = options.fetchImpl ?? fetch;
  const expectedCredential = secretDigest(`Bearer ${config.credential}`);
  const app = Fastify({ logger: false, bodyLimit: 32768, requestTimeout: config.timeoutMs + 1000 });
  app.addHook('onRequest', async (request, reply) => {
    const count = (name: string) =>
      request.raw.rawHeaders.filter((_, index) => index % 2 === 0 && request.raw.rawHeaders[index]?.toLowerCase() === name).length;
    const auth = request.headers.authorization;
    if (
      count('authorization') !== 1 ||
      typeof auth !== 'string' ||
      auth.length > 4103 ||
      !timingSafeEqual(secretDigest(auth), expectedCredential)
    )
      return reply.code(401).send({ code: 'notify.relay.unauthorized' });
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Error && 'statusCode' in error && error.statusCode === 413 ? 413 : 400)
      .send({ code: 'notify.relay.invalid_input' }),
  );
  app.get('/ready', async (_request, reply) => {
    try {
      await sql`SELECT 1 FROM notify.mailbox_relay_receipts LIMIT 1`;
      return { configured: true, upstream: 'unprobed' };
    } catch {
      return reply.code(503).send({ code: 'notify.relay.storage_unavailable' });
    }
  });
  app.post('/send', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const key = request.headers['idempotency-key'];
    const keyHeaders = request.raw.rawHeaders.filter(
      (_, index) => index % 2 === 0 && request.raw.rawHeaders[index]?.toLowerCase() === 'idempotency-key',
    ).length;
    const envelope = envelopeSchema.safeParse(request.body);
    if (
      keyHeaders !== 1 ||
      typeof key !== 'string' ||
      !/^[A-Za-z0-9._:-]{16,256}$/.test(key) ||
      !envelope.success ||
      request.url.includes('?')
    )
      return reply.code(400).send({ code: 'notify.relay.invalid_input' });
    const body = { to: [envelope.data.to], displayName: 'INTAFACED', subject: envelope.data.subject, text: envelope.data.text };
    // The key-bound fingerprint covers actual delivery and configured sender,
    // not notificationId or rendering metadata. Credentials can rotate safely.
    const fingerprint = createHmac('sha256', key)
      .update(JSON.stringify({ sender: new URL(config.sendUrl).toString(), ...body }))
      .digest('hex');
    const keyHash = hash(key),
      id = randomUUID();
    const deadline = performance.now() + config.timeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Deadline());
      }, config.timeoutMs);
    });
    const bounded = <T>(promise: PromiseLike<T>) => Promise.race([Promise.resolve(promise), expired]);
    const unknown = () => reply.code(503).send({ code: 'notify.relay.acceptance_unknown' });
    // Terminal unknown is written before the 503. A restart must not observe
    // 'attempting' after this handler has given up: that row is an unknown
    // attempt, and an in-progress claim is what a later sender could resend.
    const markUnknown = (gatewayId: string) =>
      sql`UPDATE notify.mailbox_relay_receipts SET status = 'unknown', settled_at = clock_timestamp()
        WHERE key_hash = ${keyHash} AND gateway_id = ${gatewayId} AND status = 'attempting'`.catch(() => undefined);
    const abandon = async () => {
      await markUnknown(id);
      return unknown();
    };
    try {
      const claim = sql<Receipt[]>`INSERT INTO notify.mailbox_relay_receipts
        (key_hash,envelope_hash,gateway_id,status,attempted_at,deadline_at)
        VALUES (${keyHash},${fingerprint},${id},'attempting',clock_timestamp(),clock_timestamp() + ${config.timeoutMs} * interval '1 millisecond')
        ON CONFLICT (key_hash) DO NOTHING RETURNING *`;
      let claimed: Receipt | undefined;
      try {
        [claimed] = await bounded(claim);
      } catch (error) {
        if (!(error instanceof Deadline)) throw error;
        const [lateClaim] = await claim.catch(() => [] as Receipt[]);
        if (lateClaim) await markUnknown(lateClaim.gateway_id);
        return unknown();
      }
      if (!claimed) {
        const [prior] = await bounded(sql<Receipt[]>`SELECT * FROM notify.mailbox_relay_receipts WHERE key_hash = ${keyHash}`);
        if (!prior) return unknown();
        if (prior.envelope_hash !== fingerprint) return reply.code(409).send({ code: 'notify.relay.request_conflict' });
        if (prior.status === 'accepted') return reply.send({ id: `relay:${prior.gateway_id}` });
        if (prior.status === 'refused') return reply.code(prior.upstream_status!).send({ code: 'notify.relay.upstream_refused' });
        return unknown();
      }
      if (performance.now() >= deadline) return abandon();
      const response = await bounded(
        fetchImpl(config.sendUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.sendToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        }),
      );
      // Discard every body without reading it, including upstream errors/IDs.
      void response.body?.cancel().catch(() => undefined);
      const status = response.status === 204 ? 'accepted' : [401, 403, 422].includes(response.status) ? 'refused' : 'unknown';
      if (performance.now() >= deadline) return abandon();
      const [settled] = await bounded(sql<Receipt[]>`UPDATE notify.mailbox_relay_receipts
        SET status = ${status}, upstream_status = ${status === 'refused' ? response.status : null}, settled_at = clock_timestamp()
        WHERE key_hash = ${keyHash} AND gateway_id = ${id} AND status = 'attempting'
        AND (${status} = 'unknown' OR clock_timestamp() < deadline_at) RETURNING *`);
      if (!settled) return abandon();
      if (performance.now() >= deadline) return unknown();
      if (settled.status === 'accepted') return reply.send({ id: `relay:${settled.gateway_id}` });
      if (settled.status === 'refused') return reply.code(settled.upstream_status!).send({ code: 'notify.relay.upstream_refused' });
      return unknown();
    } catch {
      // A committed attempt, including a SQL/HTTP response we lost, is never
      // reclaimed. Best-effort classification cannot grant another attempt.
      await markUnknown(id);
      return unknown();
    } finally {
      clearTimeout(timer!);
    }
  });
  return app;
}
