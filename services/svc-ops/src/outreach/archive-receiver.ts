import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertProductionPosture } from '@intafaced/config/production-posture';
import Fastify from 'fastify';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import { erasureArchiveSchema } from './restore-privacy.js';
import { archiveDigest, archiveReceiptSchema } from './archive-publication.js';

export async function migrateArchiveReceiver(sql: Sql) {
  const migration = await readFile(new URL('../../drizzle/archive/0000_archive_receiver.sql', import.meta.url), 'utf8');
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ops.archive.migrations'))`;
    if (!(await tx`SELECT 1 FROM pg_namespace WHERE nspname='ops'`).length) await tx`CREATE SCHEMA ops`;
    await tx.unsafe(migration);
  });
}
function decrypt(row: Record<string, any>, key: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(Buffer.from(`${row.intent_id}:${row.digest}`));
  decipher.setAuthTag(row.tag);
  const body = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  if (archiveDigest(body) !== row.digest) throw new Error('archive digest mismatch');
  const archive = erasureArchiveSchema.parse(JSON.parse(body));
  if (archive.version !== 2 || archive.intents.length !== 1 || archive.intents[0]!.id !== row.intent_id)
    throw new Error('archive binding mismatch');
  return { archive, body };
}
/** Standalone OPS maintenance receiver. No NATS, identity, or prospect database access. */
export async function createArchiveReceiver(config: { sql: Sql; key: Buffer; secret: string }) {
  if (config.key.length !== 32 || config.secret.length < 32) throw new Error('ops.crm.archive_configuration_invalid');
  const server = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  // Keep original bytes: whitespace and generatedAt remain immutable across unknown acceptance.
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  server.addHook('onRequest', async (request, reply) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({ code: 'ops.crm.operator_forbidden' });
    reply.header('cache-control', 'no-store');
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? ''))
      return reply.code(415).send({ code: 'ops.crm.archive_invalid' });
  });
  const readCurrent = async (tx: postgres.TransactionSql) => {
    const rows = await tx`SELECT * FROM ops.erasure_archive_packets ORDER BY generation LIMIT 10001`;
    const [head] = await tx`SELECT generation,packet_count FROM ops.erasure_archive_head WHERE singleton`;
    if (
      !head ||
      rows.length > 10000 ||
      Number(head.packet_count) !== rows.length ||
      Number(head.generation) !== (rows.length ? Number(rows[rows.length - 1]!.generation) : 0)
    )
      throw new Error('archive generation mismatch');
    const unsealed = rows.map((row) => decrypt(row, config.key));
    const packets = unsealed.map((p) => p.archive);
    const archive = erasureArchiveSchema.parse({
      version: 2,
      generatedAt: new Date().toISOString(),
      intents: packets.flatMap((p) => p.intents),
      requests: packets.flatMap((p) => p.requests),
      erasedRequestIds: [...new Set(packets.flatMap((p) => p.erasedRequestIds))].sort(),
    });
    const result = {
      packets: rows.map((row, index) => ({
        body: unsealed[index]!.body,
        receipt: {
          intentId: row.intent_id,
          digest: row.digest,
          generation: Number(row.generation),
          storedAt: new Date(row.stored_at).toISOString(),
        },
      })),

      generation: rows.length ? Number(rows[rows.length - 1]!.generation) : 0,
      digest: archiveDigest(JSON.stringify(archive)),
      archive,
    };
    if (Buffer.byteLength(JSON.stringify(result)) + 128 > 16 * 1024 * 1024) throw new Error('archive capacity exceeded');
    return result;
  };
  server.post('/prepared', async (request, reply) => {
    if (typeof request.body !== 'string') return reply.code(400).send({ code: 'ops.crm.archive_invalid' });
    const body = request.body;
    const digest = archiveDigest(body);
    const parsed = erasureArchiveSchema.safeParse(
      (() => {
        try {
          return JSON.parse(body);
        } catch {
          return null;
        }
      })(),
    );
    if (
      request.headers['x-archive-digest'] !== digest ||
      !parsed.success ||
      parsed.data.version !== 2 ||
      parsed.data.intents.length !== 1 ||
      parsed.data.intents[0]!.status !== 'pending_notify'
    )
      return reply.code(400).send({ code: 'ops.crm.archive_invalid' });
    const intentId = parsed.data.intents[0]!.id;
    try {
      const result = await config.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('ops.archive.publication'))`;
        const [previous] = await tx`SELECT * FROM ops.erasure_archive_packets WHERE intent_id=${intentId}`;
        if (previous) {
          decrypt(previous, config.key);
          await readCurrent(tx);
          if (previous.digest !== digest) return null;
          return archiveReceiptSchema.parse({
            intentId,
            digest,
            generation: Number(previous.generation),
            storedAt: new Date(previous.stored_at).toISOString(),
          });
        }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', config.key, iv);
        cipher.setAAD(Buffer.from(`${intentId}:${digest}`));
        const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
        const [row] =
          await tx`INSERT INTO ops.erasure_archive_packets(intent_id,digest,ciphertext,iv,tag) VALUES (${intentId},${digest},${ciphertext},${iv},${cipher.getAuthTag()}) RETURNING generation,stored_at`;
        await tx`UPDATE ops.erasure_archive_head SET generation=${row!.generation},packet_count=packet_count+1 WHERE singleton`;
        await readCurrent(tx); // Refuse before commit if the aggregate cannot be restored through this protocol.
        return archiveReceiptSchema.parse({
          intentId,
          digest,
          generation: Number(row!.generation),
          storedAt: new Date(row!.stored_at).toISOString(),
        });
      });
      if (!result) return reply.code(409).send({ code: 'ops.crm.idempotency_conflict' });
      return result; // sql.begin has committed before Fastify sends acknowledgement.
    } catch {
      return reply.code(503).send({ code: 'ops.crm.storage_unavailable' });
    }
  });
  server.post('/current', async (request, reply) => {
    const parsed = z
      .object({ nonce: z.string().guid() })
      .strict()
      .safeParse(
        (() => {
          try {
            return JSON.parse(String(request.body));
          } catch {
            return null;
          }
        })(),
      );
    if (!parsed.success) return reply.code(400).send({ code: 'ops.crm.archive_invalid' });
    try {
      const result = await config.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('ops.archive.publication'))`;
        return { ...(await readCurrent(tx)), nonce: parsed.data.nonce };
      });
      return result;
    } catch {
      return reply.code(503).send({ code: 'ops.crm.storage_unavailable' });
    }
  });
  return server;
}
export function archiveReceiverConfiguration(environment: NodeJS.ProcessEnv) {
  const secret = environment.OPS_ERASURE_ARCHIVE_SECRET ?? '';
  const encoded = environment.OPS_ERASURE_ARCHIVE_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(encoded, 'base64url');
  const fleet = Object.entries(environment)
    .filter(([name, value]) => name !== 'OPS_ERASURE_ARCHIVE_SECRET' && Boolean(value) && /(?:SECRET|TOKEN|KEY)$/.test(name))
    .map(([, value]) => value);
  let publicUrl: URL;
  try {
    publicUrl = new URL(environment.OPS_ERASURE_ARCHIVE_URL ?? '');
  } catch {
    throw new Error('ops.crm.archive_configuration_invalid');
  }
  if (
    !environment.OPS_ERASURE_ARCHIVE_DATABASE_URL ||
    secret.length < 32 ||
    fleet.includes(secret) ||
    key.length !== 32 ||
    key.toString('base64url') !== encoded ||
    encoded === secret ||
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash ||
    environment.OPS_ERASURE_ARCHIVE_TLS_INGRESS !== 'trusted_loopback'
  )
    throw new Error('ops.crm.archive_configuration_invalid');
  return { url: environment.OPS_ERASURE_ARCHIVE_DATABASE_URL, key, secret };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sql: Sql | undefined;
  let server: Awaited<ReturnType<typeof createArchiveReceiver>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Always attempt both resources, even when one close fails.
      const results = await Promise.allSettled([server?.close(), sql?.end({ timeout: 1 })]);
      if (results.some((result) => result.status === 'rejected')) throw new Error('ops.crm.archive_startup_failed');
    })());
  const fail = () => {
    process.stderr.write('ops.crm.archive_startup_failed\n');
    process.exitCode = 1;
  };
  // This entrypoint skips loadEnv, so it asks the production-posture question itself. The message
  // names variables, never values, so it is safe to print.
  try {
    assertProductionPosture(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ops.crm.production_posture_refused'}\n`);
    process.exit(1);
  }
  try {
    const configuration = archiveReceiverConfiguration(process.env);
    sql = postgres(configuration.url, { max: 2, connect_timeout: 3, onnotice: () => undefined });
    await migrateArchiveReceiver(sql);
    server = await createArchiveReceiver({ sql, key: configuration.key, secret: configuration.secret });
    const port = z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .parse(process.env.OPS_ERASURE_ARCHIVE_PORT ?? '4122');
    await server.listen({ host: '127.0.0.1', port });
    const shutdown = async () => {
      try {
        await close();
      } catch {
        fail();
      }
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  } catch {
    try {
      await close();
    } catch {
      /* The fixed failure below covers cleanup failures too. */
    }
    fail();
  }
}
