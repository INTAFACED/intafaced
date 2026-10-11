import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { createTranslator, isMessageKey } from '@intafaced/i18n';
import {
  guestNotificationSendInputSchema,
  guestNotificationGetInputSchema,
  guestNotificationReceiptSchema,
  guestNotificationEraseInputSchema,
  guestNotificationEraseReceiptSchema,
  guestNotificationCodeSchema,
  type GuestNotificationSendInput,
  type GuestNotificationReceipt,
} from '@intafaced/contracts';
import type { z } from 'zod';
import { ChannelDeliveryError, ChannelRefusal, type NotificationChannel, type OutboundMessage } from '../channels/channel.js';

export class GuestNotificationError extends Error {
  constructor(
    readonly code: z.infer<typeof guestNotificationCodeSchema>,
    message: string = code,
  ) {
    super(message);
  }
}
type Row = {
  id: string;
  business_key: string;
  fingerprint: string;
  payload: GuestNotificationSendInput;
  status: GuestNotificationReceipt['status'];
  code: GuestNotificationReceipt['code'];
  reference: string | null;
  attempted_at: Date | null;
  accepted_at: Date | null;
  claim_token: string | null;
};
const digest = (input: GuestNotificationSendInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function receipt(row: Row): GuestNotificationReceipt {
  return guestNotificationReceiptSchema.parse({
    notificationId: row.id,
    businessKey: row.business_key,
    status: row.status,
    code: row.code,
    reference: row.reference,
    attemptedAt: row.attempted_at?.toISOString() ?? null,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
  });
}
function message(row: Row): OutboundMessage {
  const input = row.payload;
  const kind = input.message.kind;
  const translator = createTranslator('en', undefined, { mode: 'prod' });
  const titleKey = `notify.outreach.${kind}.title`;
  const bodyKey = `notify.outreach.${kind}.body`;
  const params = input.message.kind === 'enquiry_acknowledgement' ? undefined : { staffText: input.message.staffText };
  return {
    notificationId: row.id,
    userId: input.contactId,
    channel: 'email',
    kind,
    severity: 'info',
    titleKey,
    bodyKey,
    title: translator.tUnsafe(titleKey),
    body: translator.tUnsafe(bodyKey, params),
    href: null,
    locale: 'en',
    address: input.recipientEmail,
    // Business identity survives restoration of an older notify database;
    // the generated row ID does not. Keep the transport key opaque.
    idempotencyKey: `guest-email-v1:${createHash('sha256').update(row.business_key).digest('hex')}`,
  };
}

/** Owned prospect messages; no identity or platform-target lookup. */
export class GuestNotificationService {
  constructor(
    private readonly sql: Sql,
    private readonly email: NotificationChannel | null,
    private readonly options: {
      enabled?: boolean;
      timeoutMs?: number;
      leaseMs?: number;
      addressMaxPerWindow?: number;
      addressWindowMs?: number;
    } = {},
  ) {}
  private async expire(tx: Sql, businessKey: string): Promise<void> {
    await tx`UPDATE notify.guest_notifications SET status = 'unresolved', code = 'guest.acceptance_unknown',
      lease_until = NULL, updated_at = now() WHERE business_key = ${businessKey} AND status = 'attempting' AND lease_until <= clock_timestamp()`;
  }
  async send(raw: GuestNotificationSendInput): Promise<GuestNotificationReceipt> {
    const parsed = guestNotificationSendInputSchema.parse(raw);
    const input = {
      ...parsed,
      contactId: parsed.contactId.toLowerCase(),
      submissionId: parsed.submissionId.toLowerCase(),
      message:
        parsed.message.kind === 'enquiry_acknowledgement'
          ? parsed.message
          : { ...parsed.message, activityId: parsed.message.activityId.toLowerCase() },
    };
    try {
      const prepared = await transaction(
        this.sql,
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest.submission:${input.submissionId}`}, 0))`;
          if ((await tx`SELECT 1 FROM notify.guest_erased_submissions WHERE submission_id = ${input.submissionId}`).length)
            throw new GuestNotificationError('guest.submission_erased');
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest:${input.businessKey}`}, 0))`;
          await this.expire(tx, input.businessKey);
          const [prior] = await tx<Row[]>`SELECT * FROM notify.guest_notifications WHERE business_key = ${input.businessKey}`;
          if (prior && prior.fingerprint !== digest(input)) throw new GuestNotificationError('guest.request_conflict');
          if (
            prior &&
            !(
              prior.status === 'queued' ||
              (prior.status === 'refused' &&
                prior.attempted_at === null &&
                ['guest.notification_unconfigured', 'guest.configuration_unverified', 'guest.address_rate_limited'].includes(
                  prior.code ?? '',
                ))
            )
          )
            return { row: prior, attempt: false };
          let row = prior;
          if (!row) {
            [row] = await tx<Row[]>`INSERT INTO notify.guest_notifications(business_key, fingerprint, submission_id, payload, status)
            VALUES (${input.businessKey}, ${digest(input)}, ${input.submissionId}, ${tx.json(input)}, 'queued') RETURNING *`;
          }
          const missing = !this.email || this.email.unavailableReason !== null;
          const catalogReady =
            isMessageKey(`notify.outreach.${input.message.kind}.title`) && isMessageKey(`notify.outreach.${input.message.kind}.body`);
          if (missing || this.options.enabled === false || this.email?.channel !== 'email' || !catalogReady) {
            const code = missing ? 'guest.notification_unconfigured' : 'guest.configuration_unverified';
            [row] = await tx<Row[]>`UPDATE notify.guest_notifications SET status = 'refused', code = ${code}, updated_at = now()
            WHERE business_key = ${input.businessKey} RETURNING *`;
            return { row: row!, attempt: false };
          }
          const addressHash = createHash('sha256').update(input.recipientEmail.toLowerCase()).digest('hex');
          const windowMs = this.options.addressWindowMs ?? 900000;
          await tx`DELETE FROM notify.guest_address_rate_windows
          WHERE window_start < floor(extract(epoch FROM clock_timestamp()) * 1000 / ${windowMs})::bigint - 1`;
          const budget = await tx`INSERT INTO notify.guest_address_rate_windows(address_hash, window_start, attempts)
          VALUES (${addressHash}, floor(extract(epoch FROM clock_timestamp()) * 1000 / ${windowMs})::bigint, 1)
          ON CONFLICT (address_hash, window_start) DO UPDATE SET attempts = guest_address_rate_windows.attempts + 1
          WHERE guest_address_rate_windows.attempts < ${this.options.addressMaxPerWindow ?? 3} RETURNING attempts`;
          if (!budget.length) {
            [row] = await tx<
              Row[]
            >`UPDATE notify.guest_notifications SET status = 'refused', code = 'guest.address_rate_limited', updated_at = now()
            WHERE business_key = ${input.businessKey} RETURNING *`;
            return { row: row!, attempt: false };
          }
          [row] = await tx<Row[]>`UPDATE notify.guest_notifications SET status = 'attempting', code = NULL,
          attempted_at = clock_timestamp(), claim_token = ${randomUUID()}, lease_until = clock_timestamp() + ${this.options.leaseMs ?? (this.options.timeoutMs ?? 5000) + 1000} * interval '1 millisecond', updated_at = now()
          WHERE business_key = ${input.businessKey} RETURNING *`;
          return { row: row!, attempt: true };
        },
        { isolation: 'read committed' },
      );
      if (!prepared.attempt) return receipt(prepared.row);
      let status: 'accepted' | 'refused' | 'unresolved';
      let code: GuestNotificationReceipt['code'] = null;
      let reference: string | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.email!.deliver(message(prepared.row)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Guest gateway deadline')), this.options.timeoutMs ?? 5000);
          }),
        ]);
        status = 'accepted';
        // Never retain gateway error bodies or a URL containing a token as a reference.
        reference =
          result.reference && /^[A-Za-z0-9._:-]{1,256}$/.test(result.reference) && !result.reference.includes('://')
            ? result.reference
            : null;
      } catch (error) {
        const refused =
          error instanceof ChannelRefusal ||
          (error instanceof ChannelDeliveryError &&
            error.status !== null &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 425, 429].includes(error.status));
        status = refused ? 'refused' : 'unresolved';
        code = refused ? 'guest.gateway_refused' : 'guest.acceptance_unknown';
      } finally {
        if (timer) clearTimeout(timer);
      }
      const [finished] = await this.sql<
        Row[]
      >`UPDATE notify.guest_notifications SET status = ${status}, code = ${code}, reference = ${reference},
        accepted_at = CASE WHEN ${status} = 'accepted' THEN greatest(attempted_at, clock_timestamp()) ELSE NULL END, lease_until = NULL, updated_at = now()
        WHERE id = ${prepared.row.id} AND claim_token = ${prepared.row.claim_token} AND status = 'attempting' RETURNING *`;
      return finished ? receipt(finished) : (await this.get({ businessKey: input.businessKey }))!;
    } catch (error) {
      if (error instanceof GuestNotificationError) throw error;
      throw new GuestNotificationError('guest.storage_unavailable');
    }
  }
  async get(raw: { businessKey: string }): Promise<GuestNotificationReceipt | null> {
    const input = guestNotificationGetInputSchema.parse(raw);
    try {
      await this.expire(this.sql, input.businessKey);
      const [row] = await this.sql<Row[]>`SELECT * FROM notify.guest_notifications WHERE business_key = ${input.businessKey}`;
      return row ? receipt(row) : null;
    } catch {
      throw new GuestNotificationError('guest.storage_unavailable');
    }
  }
  async eraseSubmission(
    raw: z.infer<typeof guestNotificationEraseInputSchema>,
  ): Promise<z.infer<typeof guestNotificationEraseReceiptSchema>> {
    const parsed = guestNotificationEraseInputSchema.parse(raw);
    const input = { requestId: parsed.requestId.toLowerCase(), submissionId: parsed.submissionId.toLowerCase() };
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest.erase:${input.requestId}`}, 0))`;
          const [previous] = await tx<
            Array<{ submission_id: string; result: unknown }>
          >`SELECT * FROM notify.guest_erasure_requests WHERE request_id = ${input.requestId}`;
          if (previous) {
            if (previous.submission_id !== input.submissionId) throw new GuestNotificationError('guest.request_conflict');
            return guestNotificationEraseReceiptSchema.parse(previous.result);
          }
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest.submission:${input.submissionId}`}, 0))`;
          await tx`UPDATE notify.guest_notifications SET status = 'unresolved', code = 'guest.acceptance_unknown', lease_until = NULL, updated_at = now()
          WHERE submission_id = ${input.submissionId} AND status = 'attempting' AND lease_until <= clock_timestamp()`;
          if (
            (await tx`SELECT id FROM notify.guest_notifications WHERE submission_id = ${input.submissionId} AND status = 'attempting'`)
              .length
          )
            throw new GuestNotificationError('guest.delivery_in_progress');
          const [tombstone] = await tx<Array<{ erased_at: Date }>>`INSERT INTO notify.guest_erased_submissions(submission_id)
          VALUES (${input.submissionId}) ON CONFLICT DO NOTHING RETURNING erased_at`;
          const erased = await tx`UPDATE notify.guest_notifications SET payload = NULL, erased_at = now(), reference = NULL,
          status = CASE WHEN attempted_at IS NULL THEN 'refused' ELSE status END,
          code = CASE WHEN attempted_at IS NULL THEN 'guest.submission_erased' ELSE code END, updated_at = now()
          WHERE submission_id = ${input.submissionId} AND erased_at IS NULL RETURNING id`;
          const result = guestNotificationEraseReceiptSchema.parse({
            ...input,
            erasedCount: erased.length,
            erasedAt: (tombstone?.erased_at ?? new Date()).toISOString(),
          });
          await tx`INSERT INTO notify.guest_erasure_requests(request_id, submission_id, result)
          VALUES (${input.requestId}, ${input.submissionId}, ${tx.json(result)})`;
          return result;
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof GuestNotificationError) throw error;
      throw new GuestNotificationError('guest.storage_unavailable');
    }
  }
}
