import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import { archiveDigest, createArchiveClient } from './archive-publication.js';
import Fastify from 'fastify';
import { archiveReceiverConfiguration, createArchiveReceiver, migrateArchiveReceiver } from './archive-receiver.js';
import { applyErasureArchive, reapplyCompletedErasures } from './restore-privacy.js';
import type { OutreachNotificationPort } from './notification-client.js';

function fixtureRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error('fixture row missing');
  return row;
}

const founders: [string, string] = [randomUUID(), randomUUID()];
const configuration = {
  founders,
  initialOwnerUserId: founders[0],
  continuationTtlSeconds: 3600,
  timeZone: 'UTC',
  businessWeekdays: [1, 2, 3, 4, 5],
  reviewHour: 9,
  reviewMinute: 15,
};
const capture = () => ({
  requestId: randomUUID(),
  continuationToken: randomBytes(32).toString('base64url'),
  contact: {
    name: 'Private fixture',
    email: 'fixture@example.test',
    organisationName: 'Fixture',
    interests: ['investor' as const],
    marketingOptIn: false,
  },
});
// Real SQL plus a local HTTP receiver per test; the 5 s default is too tight under CI load.
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('independent prepared archive barrier SQL/HTTP', { timeout: 30_000 }, () => {
  let source: TestDatabase, receiverDb: TestDatabase, restored: TestDatabase;
  let server: Awaited<ReturnType<typeof createArchiveReceiver>>;
  const secret = randomBytes(40).toString('base64url');
  beforeAll(async () => {
    source = await createTestDatabase({ service: 'ops' });
    receiverDb = await createTestDatabase({ service: 'ops' });
    restored = await createTestDatabase({ service: 'ops' });
    await migrateOutreach(source.sql);
    await migrateOutreach(restored.sql);
    await migrateArchiveReceiver(receiverDb.sql);
    server = await createArchiveReceiver({ sql: receiverDb.sql, key: randomBytes(32), secret });
    await server.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await server?.close();
    await source?.drop();
    await receiverDb?.drop();
    await restored?.drop();
  });
  const port = () => {
    const eraseSubmission = vi.fn<OutreachNotificationPort['eraseSubmission']>(async (input) => ({
      ...input,
      erasedCount: 1,
      erasedAt: new Date().toISOString(),
    }));
    return { configured: true, get: async () => null, send: async () => null, eraseSubmission };
  };
  it('commits immutable bytes before a lost ACK; retry publishes same packet before any erase and restores old capture safely', async () => {
    const notify = port();
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('address');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = createArchiveClient({ environment: 'test', url: origin, secret });
    let lost = true;
    const sent: string[] = [];
    const publisher = {
      publish: async (body: string) => {
        sent.push(body);
        const ack = await client.publish(body);
        if (lost) {
          lost = false;
          throw new Error('lost ACK');
        }
        return ack;
      },
    };
    const crm = new OutreachCrm(source.sql, configuration, undefined, notify, publisher);
    const input = capture();
    const original = await crm.capture(input, randomUUID());
    // A separately owned restored DB represents the older backup before intent creation.
    const dump = execFileSync(
      process.env.PG_DUMP_BIN ?? 'pg_dump',
      ['--data-only', '--schema=ops', '--exclude-table=ops.crm_migrations', '--dbname', source.url],
      { encoding: 'utf8' },
    );
    execFileSync(process.env.PSQL_BIN ?? 'psql', ['-X', '--set', 'ON_ERROR_STOP=1', '--dbname', restored.url], {
      input: dump,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const sub = fixtureRow(await source.sql`SELECT contact_id FROM ops.crm_submissions WHERE id=${original.submissionId}`);
    const preview = await crm.privacy.preview({ canonicalContactId: sub.contact_id }, founders[0]);
    const intent = await crm.privacy.begin(
      {
        requestId: randomUUID(),
        canonicalContactId: sub.contact_id,
        expectedCanonicalRevision: preview.canonicalRevision,
        snapshot: preview.snapshot,
        confirmedEntireCluster: true,
        reason: 'confirmed_privacy_request',
      },
      founders[0],
    );
    const advance = { requestId: randomUUID(), intentId: intent.intentId, expectedRevision: intent.revision };
    await expect(crm.privacy.advance(advance, founders[0])).rejects.toMatchObject({ code: 'ops.crm.storage_unavailable' });
    expect(notify.eraseSubmission).not.toHaveBeenCalled();
    expect((await source.sql`SELECT 1 FROM ops.crm_contacts WHERE id=${sub.contact_id}`).length).toBe(1);
    const frozen = fixtureRow(await source.sql`SELECT body,digest FROM ops.crm_erasure_publications WHERE intent_id=${intent.intentId}`);
    expect(frozen.digest).toBe(archiveDigest(frozen.body));
    expect(JSON.parse(frozen.body).erasedRequestIds).toContain(input.requestId);
    const restarted = new OutreachCrm(source.sql, configuration, undefined, notify, client);
    notify.eraseSubmission.mockImplementation(async (input) => {
      expect((await receiverDb.sql`SELECT 1 FROM ops.erasure_archive_packets WHERE intent_id=${intent.intentId}`).length).toBe(1);
      return { ...input, erasedCount: 1, erasedAt: new Date().toISOString() };
    });
    const result = await restarted.privacy.advance(advance, founders[0]);
    expect(result.status).toBe('complete');
    const durable = fixtureRow(
      await receiverDb.sql`SELECT digest,ciphertext FROM ops.erasure_archive_packets WHERE intent_id=${intent.intentId}`,
    );
    expect(durable.digest).toBe(frozen.digest);
    expect(Buffer.from(durable.ciphertext).toString()).not.toContain('fixture@example');
    expect(notify.eraseSubmission).toHaveBeenCalledOnce();
    expect(sent[0]).toBe(frozen.body);
    const current = await client.current();
    expect(current.archive.intents[0]!.status).toBe('pending_notify');
    await applyErasureArchive(source.sql, current.archive, current.packets);
    expect((await crm.privacy.status({ intentId: intent.intentId }, founders[0])).status).toBe('complete');
    await expect(reapplyCompletedErasures(source.sql, createArchiveClient({ environment: 'prod' }))).rejects.toMatchObject({
      code: 'ops.crm.storage_unconfigured',
    });
    await applyErasureArchive(restored.sql, current.archive, current.packets);
    await expect(new OutreachCrm(restored.sql, configuration).capture(input, randomUUID())).rejects.toMatchObject({
      code: 'ops.crm.continuation_invalid',
    });
    expect(current.archive.intents[0]!.notifications[0]!.requestId).toBe(notify.eraseSubmission.mock.calls[0]![0].requestId);
    expect((await restored.sql`SELECT 1 FROM ops.crm_contacts WHERE id=${sub.contact_id}`).length).toBe(1);
    const restoredCrm = new OutreachCrm(restored.sql, configuration, undefined, notify, client);
    const pending = current.archive.intents[0]!;
    await restoredCrm.privacy.advance({ requestId: randomUUID(), intentId: pending.id, expectedRevision: pending.revision }, founders[0]);
    expect((await restored.sql`SELECT 1 FROM ops.crm_contacts WHERE id=${sub.contact_id}`).length).toBe(0);
    expect(notify.eraseSubmission.mock.calls[1]![0]).toEqual(notify.eraseSubmission.mock.calls[0]![0]);
  });
  it('production missing config and mismatched ACK refuse before notify', async () => {
    await expect(createArchiveClient({ environment: 'prod' }).publish('{}')).rejects.toMatchObject({
      code: 'ops.crm.storage_unconfigured',
    });
    await expect(createArchiveClient({ environment: 'staging', url: 'http://127.0.0.1:1', secret }).publish('{}')).rejects.toMatchObject({
      code: 'ops.crm.storage_unconfigured',
    });
  });
  it('prod constructor omission cannot bypass required publication', async () => {
    const notify = port();
    vi.stubEnv('APP_ENV', 'prod');
    vi.stubEnv('OPS_ERASURE_ARCHIVE_URL', '');
    vi.stubEnv('OPS_ERASURE_ARCHIVE_SECRET', '');
    try {
      const crm = new OutreachCrm(source.sql, configuration, undefined, notify);
      const receipt = await crm.capture(capture(), randomUUID());
      const sub = fixtureRow(await source.sql`SELECT contact_id FROM ops.crm_submissions WHERE id=${receipt.submissionId}`);
      const preview = await crm.privacy.preview({ canonicalContactId: sub.contact_id }, founders[0]);
      const pending = await crm.privacy.begin(
        {
          requestId: randomUUID(),
          canonicalContactId: sub.contact_id,
          expectedCanonicalRevision: preview.canonicalRevision,
          snapshot: preview.snapshot,
          confirmedEntireCluster: true,
          reason: 'confirmed_privacy_request',
        },
        founders[0],
      );
      await expect(
        crm.privacy.advance({ requestId: randomUUID(), intentId: pending.intentId, expectedRevision: pending.revision }, founders[0]),
      ).rejects.toMatchObject({ code: 'ops.crm.storage_unconfigured' });
      expect(notify.eraseSubmission).not.toHaveBeenCalled();
      expect((await source.sql`SELECT 1 FROM ops.crm_contacts WHERE id=${sub.contact_id}`).length).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(['mismatch', 'refused', 'timeout'] as const)(
    'HTTP %s leaves original contact and committed packet without notify',
    async (mode) => {
      const fault = Fastify();
      fault.post('/prepared', async (request, reply) => {
        if (mode === 'refused') return reply.code(503).send({});
        if (mode === 'timeout') {
          await new Promise((resolve) => setTimeout(resolve, 3200));
          return {};
        }
        return {
          intentId: randomUUID(),
          digest: archiveDigest(JSON.stringify(request.body)),
          generation: 1,
          storedAt: new Date().toISOString(),
        };
      });
      await fault.listen({ host: '127.0.0.1', port: 0 });
      try {
        const address = fault.server.address();
        if (!address || typeof address === 'string') throw new Error('address');
        const notify = port();
        const client = createArchiveClient({ environment: 'test', url: `http://127.0.0.1:${address.port}`, secret });
        const crm = new OutreachCrm(source.sql, configuration, undefined, notify, client);
        const receipt = await crm.capture(capture(), randomUUID());
        const sub = fixtureRow(await source.sql`SELECT contact_id FROM ops.crm_submissions WHERE id=${receipt.submissionId}`);
        const preview = await crm.privacy.preview({ canonicalContactId: sub.contact_id }, founders[0]);
        const pending = await crm.privacy.begin(
          {
            requestId: randomUUID(),
            canonicalContactId: sub.contact_id,
            expectedCanonicalRevision: preview.canonicalRevision,
            snapshot: preview.snapshot,
            confirmedEntireCluster: true,
            reason: 'confirmed_privacy_request',
          },
          founders[0],
        );
        await expect(
          crm.privacy.advance({ requestId: randomUUID(), intentId: pending.intentId, expectedRevision: pending.revision }, founders[0]),
        ).rejects.toMatchObject({ code: 'ops.crm.storage_unavailable' });
        expect(notify.eraseSubmission).not.toHaveBeenCalled();
        expect((await source.sql`SELECT 1 FROM ops.crm_contacts WHERE id=${sub.contact_id}`).length).toBe(1);
        expect((await source.sql`SELECT 1 FROM ops.crm_erasure_publications WHERE intent_id=${pending.intentId}`).length).toBe(1);
      } finally {
        await fault.close();
      }
    },
  );
  it('rejects stale current responses and minimum-generation failure without local fallback', async () => {
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('address');
    const client = createArchiveClient({ environment: 'test', url: `http://127.0.0.1:${address.port}`, secret });
    const current = await client.current();
    await expect(client.current(current.generation + 1)).rejects.toMatchObject({ code: 'ops.crm.storage_unavailable' });
    const stale = Fastify();
    stale.post('/current', () => current);
    await stale.listen({ host: '127.0.0.1', port: 0 });
    try {
      const bound = stale.server.address();
      if (!bound || typeof bound === 'string') throw new Error('address');
      await expect(
        createArchiveClient({ environment: 'test', url: `http://127.0.0.1:${bound.port}`, secret }).current(),
      ).rejects.toMatchObject({ code: 'ops.crm.storage_unavailable' });
    } finally {
      await stale.close();
    }
  });
  it('rejects wrong auth, unsupported content, hash mismatch and changed intent; current replies bind fresh nonce', async () => {
    const row = fixtureRow(await source.sql`SELECT body,digest FROM ops.crm_erasure_publications LIMIT 1`);
    const request = (authorization: string, body = row.body, digest = row.digest, contentType = 'application/json') =>
      server.inject({
        method: 'POST',
        url: '/prepared',
        headers: { authorization, 'content-type': contentType, 'x-archive-digest': digest },
        payload: body,
      });
    expect((await request('Bearer wrong')).statusCode).toBe(401);
    expect((await request(`Bearer ${secret}`, row.body, '0'.repeat(64))).statusCode).toBe(400);
    expect((await request(`Bearer ${secret}`, row.body, row.digest, 'text/plain')).statusCode).toBe(415);
    const changed = JSON.stringify({ ...JSON.parse(row.body), generatedAt: new Date(Date.now() + 1000).toISOString() });
    expect((await request(`Bearer ${secret}`, changed, archiveDigest(changed))).statusCode).toBe(409);
    const duplicate = JSON.parse(row.body);
    duplicate.intents[0].id = randomUUID();
    duplicate.intents[0].requestId = randomUUID();
    duplicate.requests = [];
    const invalidAggregate = JSON.stringify(duplicate);
    expect((await request(`Bearer ${secret}`, invalidAggregate, archiveDigest(invalidAggregate))).statusCode).toBe(503);
    expect((await receiverDb.sql`SELECT 1 FROM ops.erasure_archive_packets`).length).toBe(1);
    const first = await request(`Bearer ${secret}`),
      second = await request(`Bearer ${secret}`);
    expect(first.json()).toEqual(second.json());
    await receiverDb.sql`UPDATE ops.erasure_archive_head SET packet_count=packet_count+1 WHERE singleton`;
    const invalidCurrent = await server.inject({
      method: 'POST',
      url: '/current',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ nonce: randomUUID() }),
    });
    expect(invalidCurrent.statusCode).toBe(503);
    await receiverDb.sql`UPDATE ops.erasure_archive_head SET packet_count=packet_count-1 WHERE singleton`;
    await expect(
      source.sql`UPDATE ops.crm_erasure_publications SET body='{}' WHERE intent_id=${JSON.parse(row.body).intents[0].id}`,
    ).rejects.toThrow('publication_immutable');
    await expect(receiverDb.sql`DELETE FROM ops.erasure_archive_packets`).rejects.toThrow('archive_packet_immutable');
    const current = await server.inject({
      method: 'POST',
      url: '/current',
      headers: { authorization: `Bearer ${secret}` },
      payload: { nonce: randomUUID() },
    });
    expect(current.statusCode).toBe(200);
  });
});

it('receiver deployment config requires loopback TLS ingress, independent key and distinct private bearer', () => {
  const environment = {
    OPS_ERASURE_ARCHIVE_URL: 'https://archive.example.test',
    OPS_ERASURE_ARCHIVE_DATABASE_URL: 'postgres://fixture/archive_test',
    OPS_ERASURE_ARCHIVE_SECRET: randomBytes(40).toString('base64url'),
    OPS_ERASURE_ARCHIVE_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    OPS_ERASURE_ARCHIVE_TLS_INGRESS: 'trusted_loopback',
  };
  expect(archiveReceiverConfiguration(environment).key.length).toBe(32);
  expect(() => archiveReceiverConfiguration({ ...environment, OPS_ERASURE_ARCHIVE_TLS_INGRESS: undefined })).toThrow();
  expect(() => archiveReceiverConfiguration({ ...environment, OPS_ERASURE_ARCHIVE_URL: 'http://archive.example.test' })).toThrow();
  expect(() => archiveReceiverConfiguration({ ...environment, INTERNAL_SERVICE_SECRET: environment.OPS_ERASURE_ARCHIVE_SECRET })).toThrow();
  expect(() => archiveReceiverConfiguration({ ...environment, OPS_ERASURE_ARCHIVE_ENCRYPTION_KEY: 'incorrect' })).toThrow();
});
