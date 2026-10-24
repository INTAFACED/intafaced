import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { guestNotificationEraseReceiptSchema } from '@intafaced/contracts';
import { z } from 'zod';

const id = z.string().guid();
const timestamp = z.string().datetime({ offset: true });
const ids = (max: number, min = 0) =>
  z
    .array(id)
    .min(min)
    .max(max)
    .refine((v) => new Set(v).size === v.length);
const intent = z
  .object({
    id,
    canonicalContactId: id,
    actorUserId: id.nullable(),
    actorKind: z.enum(['founder', 'system']).default('founder'),
    requestId: id,
    reason: z.enum(['confirmed_privacy_request', 'approved_retention_policy']),
    revision: z.number().int().positive().safe(),
    status: z.enum(['pending_notify', 'complete']),
    requestedAt: timestamp,
    completedAt: timestamp.nullable(),
    errorCode: z
      .enum(['ops.crm.notification_unconfigured', 'ops.crm.notification_erasure_unknown', 'ops.crm.notification_in_flight'])
      .nullable(),
    contactIds: ids(200, 1),
    submissionIds: ids(200),
    opportunityIds: ids(1000),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    notifications: z
      .array(z.object({ submissionId: id, requestId: id, receipt: guestNotificationEraseReceiptSchema.nullable() }).strict())
      .max(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.actorKind === 'founder' && v.actorUserId === null) ||
      (v.actorKind === 'system' && (v.actorUserId !== null || v.reason !== 'approved_retention_policy'))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Erasure actor must match authority kind' });
    if (!v.contactIds.includes(v.canonicalContactId))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Canonical contact must be selected' });
    if (
      v.notifications.length !== v.submissionIds.length ||
      new Set(v.notifications.map((n) => n.submissionId)).size !== v.submissionIds.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Every original submission needs one notify record' });
    for (const n of v.notifications)
      if (
        !v.submissionIds.includes(n.submissionId) ||
        (n.receipt && (n.receipt.submissionId !== n.submissionId || n.receipt.requestId !== n.requestId))
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notify evidence must be exactly bound' });
    if (v.status === 'complete' && (v.completedAt === null || v.errorCode !== null || v.notifications.some((n) => n.receipt === null)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed tombstones require remote erasure evidence' });
    if (v.status === 'pending_notify' && v.completedAt !== null)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pending erasure cannot be completed' });
  });
export const erasureArchiveSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    generatedAt: timestamp,
    intents: z.array(intent).max(10000),
    erasedRequestIds: ids(100000),
    requests: z
      .array(
        z
          .object({
            requestId: id,
            actorUserId: id,
            operation: z.enum(['begin', 'advance']),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            intentId: id,
          })
          .strict(),
      )
      .max(100000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.version === 1 && v.intents.some((i) => i.actorKind !== 'founder'))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Legacy archives cannot represent system authority' });
    const selected = new Set(v.intents.map((i) => i.id));
    if (
      selected.size !== v.intents.length ||
      new Set(v.intents.map((i) => i.canonicalContactId)).size !== v.intents.length ||
      new Set(v.requests.map((i) => i.requestId)).size !== v.requests.length ||
      v.requests.some((r) => !selected.has(r.intentId))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Archive identities must be unique and bound' });
  });

/** Owned maintenance metadata only. Protect this independently of backups containing prospect data. */
export async function exportErasureArchive(sql: Sql) {
  return transaction(
    sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.privacy'))`;
      const rows = await tx`SELECT * FROM ops.crm_erasure_intents ORDER BY id LIMIT 10001`;
      const notifications = await tx`SELECT * FROM ops.crm_erasure_notifications ORDER BY intent_id,submission_id`;
      const requests = await tx`SELECT * FROM ops.crm_privacy_requests ORDER BY request_id LIMIT 100001`;
      const erased = await tx`SELECT request_id FROM ops.crm_erased_requests ORDER BY request_id LIMIT 100001`;
      return erasureArchiveSchema.parse({
        version: 2,
        generatedAt: new Date().toISOString(),
        intents: rows.map((e) => ({
          id: e.id,
          canonicalContactId: e.canonical_contact_id,
          actorUserId: e.actor_user_id,
          actorKind: e.actor_kind,
          requestId: e.request_id,
          reason: e.reason,
          revision: e.revision,
          status: e.status,
          requestedAt: new Date(e.requested_at).toISOString(),
          completedAt: e.completed_at ? new Date(e.completed_at).toISOString() : null,
          errorCode: e.error_code,
          contactIds: e.contact_ids,
          submissionIds: e.submission_ids,
          opportunityIds: e.opportunity_ids,
          snapshot: e.snapshot,
          notifications: notifications
            .filter((n) => n.intent_id === e.id)
            .map((n) => ({ submissionId: n.submission_id, requestId: n.request_id, receipt: n.receipt })),
        })),
        erasedRequestIds: erased.map((r) => r.request_id),
        requests: requests.map((r) => ({
          requestId: r.request_id,
          actorUserId: r.actor_user_id,
          operation: r.operation,
          fingerprint: r.fingerprint,
          intentId: r.intent_id,
        })),
      });
    },
    { isolation: 'read committed' },
  );
}
export async function reapplyCompletedErasures(sql: Sql, publisher?: import('./archive-publication.js').ArchivePublisher): Promise<void> {
  await transaction(
    sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.privacy'))`;
      const rows = await tx`SELECT id FROM ops.crm_erasure_intents WHERE status='complete' ORDER BY id`;
      for (const row of rows) {
        if (publisher) {
          const { confirmArchive } = await import('./archive-publication.js');
          await confirmArchive(tx, String(row.id), publisher);
        }
        await tx`SELECT ops.crm_apply_erasure(${row.id}::uuid)`;
      }
    },
    { isolation: 'read committed' },
  );
}

/** Never expose the restored database until the independently retained, current archive is applied. */
export async function applyErasureArchive(
  sql: Sql,
  raw: unknown,
  preparedPackets?: Array<{ body: string; receipt: { intentId: string; digest: string } }>,
): Promise<void> {
  const archive = erasureArchiveSchema.parse(raw);
  await transaction(
    sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ops.crm.privacy'))`;
      if (preparedPackets) {
        const { archiveDigest } = await import('./archive-publication.js');
        for (const packet of preparedPackets) {
          const parsed = erasureArchiveSchema.parse(JSON.parse(packet.body));
          if (
            parsed.intents.length !== 1 ||
            parsed.intents[0]!.id !== packet.receipt.intentId ||
            archiveDigest(packet.body) !== packet.receipt.digest ||
            !archive.intents.some((e) => isDeepStrictEqual(e, parsed.intents[0]))
          )
            throw new Error('ops.crm.restore_tombstone_conflict');
        }
      }
      for (const e of archive.intents) {
        const previous =
          await tx`SELECT * FROM ops.crm_erasure_intents WHERE id=${e.id} OR canonical_contact_id=${e.canonicalContactId} OR request_id=${e.requestId}`;
        if (
          previous.some(
            (p) =>
              p.id !== e.id ||
              p.actor_user_id !== e.actorUserId ||
              p.actor_kind !== e.actorKind ||
              p.request_id !== e.requestId ||
              p.canonical_contact_id !== e.canonicalContactId ||
              (!preparedPackets && p.revision > e.revision) ||
              (!preparedPackets && p.status === 'complete' && e.status !== 'complete') ||
              p.snapshot !== e.snapshot ||
              JSON.stringify(p.contact_ids) !== JSON.stringify(e.contactIds) ||
              JSON.stringify(p.submission_ids) !== JSON.stringify(e.submissionIds) ||
              JSON.stringify(p.opportunity_ids) !== JSON.stringify(e.opportunityIds),
          )
        )
          throw new Error('ops.crm.restore_tombstone_conflict');
        if (preparedPackets && previous[0] && previous[0].revision >= e.revision) {
          const p = previous[0];
          e.revision = p.revision;
          e.status = p.status;
          e.completedAt = p.completed_at ? new Date(p.completed_at).toISOString() : null;
          e.errorCode = p.error_code;
        }
        await tx`INSERT INTO ops.crm_erasure_intents(id,canonical_contact_id,actor_user_id,actor_kind,request_id,reason,revision,status,requested_at,completed_at,error_code,contact_ids,submission_ids,opportunity_ids,snapshot)
    VALUES (${e.id},${e.canonicalContactId},${e.actorUserId},${e.actorKind},${e.requestId},${e.reason},${e.revision},${e.status},${e.requestedAt},${e.completedAt},${e.errorCode},
      ${tx.array(e.contactIds)}::uuid[],${tx.array(e.submissionIds)}::uuid[],${tx.array(e.opportunityIds)}::uuid[],${e.snapshot})
    ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,completed_at=EXCLUDED.completed_at,error_code=EXCLUDED.error_code`;
        for (const n of e.notifications) {
          const previous =
            await tx`SELECT request_id,receipt FROM ops.crm_erasure_notifications WHERE intent_id=${e.id} AND submission_id=${n.submissionId}`;
          if (preparedPackets && previous[0]?.receipt && n.receipt === null) n.receipt = previous[0].receipt;
          if (previous.some((p) => p.request_id !== n.requestId || (p.receipt !== null && !isDeepStrictEqual(p.receipt, n.receipt))))
            throw new Error('ops.crm.restore_tombstone_conflict');
          await tx`INSERT INTO ops.crm_erasure_notifications(intent_id,submission_id,request_id,receipt) VALUES (${e.id},${n.submissionId},${n.requestId},${n.receipt ? tx.json(n.receipt) : null})
      ON CONFLICT(intent_id,submission_id) DO UPDATE SET receipt=EXCLUDED.receipt WHERE ops.crm_erasure_notifications.request_id=EXCLUDED.request_id`;
        }
      }
      if (preparedPackets)
        for (const packet of preparedPackets) {
          const [existing] = await tx`SELECT digest,body FROM ops.crm_erasure_publications WHERE intent_id=${packet.receipt.intentId}`;
          if (existing && (existing.digest !== packet.receipt.digest || existing.body !== packet.body))
            throw new Error('ops.crm.restore_tombstone_conflict');
          await tx`INSERT INTO ops.crm_erasure_publications(intent_id,body,digest,receipt) VALUES (${packet.receipt.intentId},${packet.body},${packet.receipt.digest},${tx.json(packet.receipt)}) ON CONFLICT DO NOTHING`;
        }
      for (const r of archive.requests) {
        const previous = await tx`SELECT * FROM ops.crm_privacy_requests WHERE request_id=${r.requestId}`;
        if (
          previous.some(
            (p) =>
              p.actor_user_id !== r.actorUserId ||
              p.operation !== r.operation ||
              p.fingerprint !== r.fingerprint ||
              p.intent_id !== r.intentId,
          )
        )
          throw new Error('ops.crm.restore_tombstone_conflict');
        await tx`INSERT INTO ops.crm_privacy_requests(request_id,actor_user_id,operation,fingerprint,intent_id) VALUES (${r.requestId},${r.actorUserId},${r.operation},${r.fingerprint},${r.intentId}) ON CONFLICT DO NOTHING`;
      }
      for (const requestId of archive.erasedRequestIds)
        await tx`INSERT INTO ops.crm_erased_requests(request_id) VALUES (${requestId}) ON CONFLICT DO NOTHING`;
      const completed = await tx`SELECT id FROM ops.crm_erasure_intents WHERE status='complete' ORDER BY id`;
      for (const e of completed) {
        if (preparedPackets && !preparedPackets.some((packet) => packet.receipt.intentId === e.id))
          throw new Error('ops.crm.restore_current_archive_required');
        await tx`SELECT ops.crm_apply_erasure(${e.id}::uuid)`;
      }
      await tx`DELETE FROM ops.crm_requests WHERE request_id IN (SELECT request_id FROM ops.crm_erased_requests)`;
    },
    { isolation: 'read committed' },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, path] = process.argv.slice(2);
  if (
    !process.env.DATABASE_URL ||
    (operation !== 'apply-current' && !path) ||
    !['export', 'apply', 'apply-current'].includes(operation ?? '')
  )
    throw new Error('ops.crm.restore_configuration_required');
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    if (operation === 'export') await writeFile(path!, JSON.stringify(await exportErasureArchive(sql)), { mode: 0o600, flag: 'wx' });
    else {
      if (process.env.OPS_OUTREACH_RESTORE_QUARANTINED !== '1') throw new Error('ops.crm.restore_quarantine_required');
      if (operation === 'apply-current') {
        const { createArchiveClient } = await import('./archive-publication.js');
        const client = createArchiveClient({
          environment: process.env.APP_ENV ?? 'prod',
          url: process.env.OPS_ERASURE_ARCHIVE_URL,
          secret: process.env.OPS_ERASURE_ARCHIVE_SECRET,
          fleetSecrets: [process.env.INTERNAL_SERVICE_SECRET, process.env.EDGE_PRINCIPAL_SECRET, process.env.OPS_NOTIFY_SERVICE_SECRET],
        });
        const minimum = process.env.OPS_ERASURE_ARCHIVE_MIN_GENERATION;
        if (minimum === undefined || !/^\d+$/.test(minimum)) throw new Error('ops.crm.restore_current_generation_required');
        const current = await client.current(Number(minimum));
        await applyErasureArchive(sql, current.archive, current.packets);
      } else {
        if (['prod', 'staging'].includes(process.env.APP_ENV ?? '')) throw new Error('ops.crm.restore_current_archive_required');
        if (((await stat(path!)).mode & 0o077) !== 0) throw new Error('ops.crm.restore_archive_permissions');
        await applyErasureArchive(sql, JSON.parse(await readFile(path!, 'utf8')));
      }
    }
  } finally {
    await sql.end();
  }
}
