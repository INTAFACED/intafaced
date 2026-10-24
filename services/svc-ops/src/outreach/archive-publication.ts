import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { OutreachError } from './config.js';
import { erasureArchiveSchema } from './restore-privacy.js';

export const archiveDigest = (body: string) => createHash('sha256').update(body).digest('hex');
export const archiveReceiptSchema = z
  .object({
    intentId: z.string().guid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().positive().safe(),
    storedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ArchivePublisher = { publish(body: string): Promise<z.infer<typeof archiveReceiptSchema>> };
export const publishedPacketSchema = z.object({ body: z.string().max(16 * 1024 * 1024), receipt: archiveReceiptSchema }).strict();
export const currentArchiveSchema = z
  .object({
    packets: z.array(publishedPacketSchema).max(10000),
    nonce: z.string().guid(),
    generation: z.number().int().nonnegative().safe(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    archive: erasureArchiveSchema,
  })
  .strict();

/** Caller holds the privacy gate. Commit this original body BEFORE calling the publisher. */
export async function prepareArchive(tx: Sql, intentId: string): Promise<void> {
  if ((await tx`SELECT 1 FROM ops.crm_erasure_publications WHERE intent_id=${intentId}`).length) return;
  const [e] = await tx`SELECT * FROM ops.crm_erasure_intents WHERE id=${intentId}`;
  if (!e || e.status !== 'pending_notify') return;
  const notifications = await tx`SELECT * FROM ops.crm_erasure_notifications WHERE intent_id=${intentId} ORDER BY submission_id`;
  const requests = await tx`SELECT * FROM ops.crm_privacy_requests WHERE intent_id=${intentId} ORDER BY request_id`;
  // Identical selection predicate to crm_apply_erasure: includes cached exports and original capture receipts.
  const erased = await tx`SELECT r.request_id FROM ops.crm_requests r WHERE r.submission_id=ANY(${tx.array(e.submission_ids)}::uuid[])
 OR EXISTS(SELECT 1 FROM unnest(${tx.array([...e.contact_ids, ...e.submission_ids, ...e.opportunity_ids])}::uuid[]) selected_id WHERE position(selected_id::text IN r.result::text)>0) ORDER BY r.request_id`;
  const archive = erasureArchiveSchema.parse({
    version: 2,
    generatedAt: new Date().toISOString(),
    intents: [
      {
        id: e.id,
        canonicalContactId: e.canonical_contact_id,
        actorUserId: e.actor_user_id,
        actorKind: e.actor_kind,
        requestId: e.request_id,
        reason: e.reason,
        revision: e.revision,
        status: e.status,
        requestedAt: new Date(e.requested_at).toISOString(),
        completedAt: null,
        errorCode: e.error_code,
        contactIds: e.contact_ids,
        submissionIds: e.submission_ids,
        opportunityIds: e.opportunity_ids,
        snapshot: e.snapshot,
        notifications: notifications.map((n) => ({ submissionId: n.submission_id, requestId: n.request_id, receipt: n.receipt })),
      },
    ],
    erasedRequestIds: erased.map((r) => r.request_id),
    requests: requests.map((r) => ({
      requestId: r.request_id,
      actorUserId: r.actor_user_id,
      operation: r.operation,
      fingerprint: r.fingerprint,
      intentId: r.intent_id,
    })),
  });
  const body = JSON.stringify(archive);
  await tx`INSERT INTO ops.crm_erasure_publications(intent_id,body,digest) VALUES (${intentId},${body},${archiveDigest(body)})`;
}
export async function confirmArchive(tx: Sql, intentId: string, publisher: ArchivePublisher): Promise<void> {
  const [packet] = await tx`SELECT body,digest FROM ops.crm_erasure_publications WHERE intent_id=${intentId}`;
  if (!packet || archiveDigest(packet.body) !== packet.digest) throw new OutreachError('ops.crm.storage_unavailable');
  try {
    // Reconfirm even a locally saved receipt: restore must not trust rolled-back/local-only authority.
    const receipt = archiveReceiptSchema.parse(await publisher.publish(packet.body));
    if (receipt.intentId !== intentId || receipt.digest !== packet.digest) throw new Error('receipt mismatch');
    await tx`UPDATE ops.crm_erasure_publications SET receipt=${tx.json(receipt)} WHERE intent_id=${intentId}`;
  } catch (error) {
    if (error instanceof OutreachError) throw error;
    throw new OutreachError('ops.crm.storage_unavailable');
  }
}

export function createArchiveClient(config: {
  environment: string;
  url?: string;
  secret?: string;
  fleetSecrets?: Array<string | undefined>;
}) {
  let origin: URL | undefined;
  try {
    const parsed = new URL(config.url ?? '');
    if (
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === '/' &&
      (parsed.protocol === 'https:' || (['dev', 'test'].includes(config.environment) && parsed.protocol === 'http:'))
    )
      origin = parsed;
  } catch {
    /* Refuse below. */
  }
  const configured = Boolean(
    origin && config.secret && config.secret.length >= 32 && !config.fleetSecrets?.filter(Boolean).includes(config.secret),
  );
  async function request(path: string, body: string, headers: Record<string, string> = {}) {
    if (!configured) throw new OutreachError('ops.crm.storage_unconfigured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(new URL(path, origin), {
        method: 'POST',
        headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json', ...headers },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('archive refused');
      const text = await response.text();
      if (text.length > 16 * 1024 * 1024) throw new Error('archive too large');
      return JSON.parse(text);
    } catch {
      throw new OutreachError('ops.crm.storage_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async publish(body: string) {
      const receipt = archiveReceiptSchema.parse(await request('/prepared', body, { 'x-archive-digest': archiveDigest(body) }));
      const packet = erasureArchiveSchema.parse(JSON.parse(body));
      if (packet.intents.length !== 1 || receipt.intentId !== packet.intents[0]!.id || receipt.digest !== archiveDigest(body))
        throw new OutreachError('ops.crm.storage_unavailable');
      return receipt;
    },
    async current(minimumGeneration = 0) {
      if (!z.number().int().nonnegative().safe().safeParse(minimumGeneration).success)
        throw new OutreachError('ops.crm.storage_unavailable');
      const nonce = randomUUID();
      try {
        const result = currentArchiveSchema.parse(await request('/current', JSON.stringify({ nonce })));
        if (
          result.generation < minimumGeneration ||
          result.nonce !== nonce ||
          result.digest !== archiveDigest(JSON.stringify(result.archive))
        )
          throw new Error('current archive mismatch');
        const originals = [];
        for (const packet of result.packets) {
          const parsed = erasureArchiveSchema.parse(JSON.parse(packet.body));
          if (
            parsed.version !== 2 ||
            parsed.intents.length !== 1 ||
            parsed.intents[0]!.status !== 'pending_notify' ||
            parsed.intents[0]!.id !== packet.receipt.intentId ||
            archiveDigest(packet.body) !== packet.receipt.digest ||
            packet.receipt.generation > result.generation
          )
            throw new Error('packet mismatch');
          originals.push(parsed);
        }
        if ((result.packets.length ? Math.max(...result.packets.map((p) => p.receipt.generation)) : 0) !== result.generation)
          throw new Error('generation mismatch');
        const aggregate = {
          version: 2,
          generatedAt: result.archive.generatedAt,
          intents: originals.flatMap((p) => p.intents),
          requests: originals.flatMap((p) => p.requests),
          erasedRequestIds: [...new Set(originals.flatMap((p) => p.erasedRequestIds))].sort(),
        };
        if (!isDeepStrictEqual(aggregate, result.archive)) throw new Error('aggregate mismatch');
        return result;
      } catch (error) {
        if (error instanceof OutreachError) throw error;
        throw new OutreachError('ops.crm.storage_unavailable');
      }
    },
  };
}
