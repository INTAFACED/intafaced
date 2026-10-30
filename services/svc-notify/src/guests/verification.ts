import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { createTranslator } from '@intafaced/i18n';
import {
  guestVerificationEraseInputSchema,
  guestVerificationEraseReceiptSchema,
  guestVerificationGetInputSchema,
  guestVerificationLinkMatches,
  guestVerificationReceiptSchema,
  guestVerificationSendInputSchema,
  type GuestVerificationCode,
  type GuestVerificationEraseReceipt,
  type GuestVerificationReceipt,
  type GuestVerificationSendInput,
} from '@intafaced/contracts';
import { ChannelDeliveryError, ChannelRefusal, type NotificationChannel } from '../channels/channel.js';
import type { StatusMailer } from '../status-page/mailer.js';

/**
 * The guest verification door (ADR 2026-10-22 §3.5, SP-tickets-01): one email per link, asked for by svc-support.
 *
 * The link carries the token the guest proves the address with, so it is rendered into the email and never stored: a row
 * keeps the token's id, its expiry and the address. The link's origin must equal the configured customer app origin; a
 * blank origin refuses before anything is written. Rows are tagged with the producer, which comes from the verified
 * caller, never from the body: a producer reads and erases its own rows only.
 *
 * Write first, then send. The row is claimed (`attempting`, with a lease) before the mailer is asked, so a crash between
 * the two leaves an attempt that expires to `unresolved` and is never sent again under that key: a resend is a new key
 * with a fresh link from svc-support. With no sender, nothing is attempted and the row is refused
 * `guest.notification_unconfigured` (svc-support shows `vendor.email`); a later call under the same key tries again once
 * a sender exists.
 */
export class GuestVerificationError extends Error {
  constructor(readonly code: GuestVerificationCode) {
    super(code);
    this.name = 'GuestVerificationError';
  }
}

export type Producer = 'svc-support';

/** One verification email, rendered. `transportKey` is opaque: the request id never reaches an outside sender. */
export type GuestVerificationMail = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly transportKey: string;
};

/** How a verification email leaves: the owner's email gateway, the LOCAL TEST outbox, or nothing. */
export interface GuestMailSender {
  /** `vendor.email` when nothing can send: the row is refused as unconfigured and nothing is attempted. */
  readonly notConnected: 'vendor.email' | null;
  /** `unknown` when the sender may or may not have taken it: never sent again under that key. */
  send(mail: GuestVerificationMail): Promise<'accepted' | 'refused' | 'unknown'>;
}

export const NO_GUEST_MAIL_SENDER: GuestMailSender = {
  notConnected: 'vendor.email',
  send: async () => 'refused',
};

/** The owner's email gateway channel. A permanent refusal (4xx other than 408, 425, 429) is refused; anything else unknown. */
export function channelGuestMailSender(channel: NotificationChannel | undefined | null): GuestMailSender {
  if (!channel || channel.channel !== 'email' || channel.unavailableReason !== null) return NO_GUEST_MAIL_SENDER;
  return {
    notConnected: null,
    async send(mail) {
      try {
        await channel.deliver({
          notificationId: mail.transportKey,
          userId: 'support-guest',
          channel: 'email',
          kind: 'support.guest_verify',
          severity: 'info',
          titleKey: 'notify.support.guest_verify.title',
          bodyKey: 'notify.support.guest_verify.body',
          title: mail.subject,
          body: mail.text,
          href: null,
          locale: 'en',
          address: mail.to,
          idempotencyKey: mail.transportKey,
        });
        return 'accepted';
      } catch (error) {
        if (error instanceof ChannelRefusal) return 'refused';
        if (
          error instanceof ChannelDeliveryError &&
          error.status !== null &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status)
        )
          return 'refused';
        return 'unknown';
      }
    },
  };
}

/** The LOCAL TEST outbox the status mailer writes (dev and test only, refused elsewhere at boot). */
export function outboxGuestMailSender(mailer: StatusMailer): GuestMailSender {
  if (mailer.kind !== 'local-outbox') return NO_GUEST_MAIL_SENDER;
  return {
    notConnected: null,
    async send(mail) {
      const outcome = await mailer.send({
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        key: mail.transportKey,
        purpose: 'guest-verify',
      });
      return outcome.status === 'accepted' ? 'accepted' : outcome.status === 'refused' ? 'refused' : 'unknown';
    },
  };
}

type Row = {
  id: string;
  business_key: string;
  fingerprint: string;
  status: GuestVerificationReceipt['status'];
  code: GuestVerificationCode | null;
  reference: string | null;
  attempted_at: Date | null;
  accepted_at: Date | null;
  claim_token: string | null;
  lease_until: Date | null;
};

/** What a send is about, without the link: a replay under the same key must ask for the same thing. */
const fingerprint = (input: GuestVerificationSendInput) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.businessKey,
        input.guestRequestId.toLowerCase(),
        input.recipientEmail.toLowerCase(),
        input.tokenId,
        new Date(input.expiresAt).toISOString(),
      ]),
    )
    .digest('hex');

function receipt(row: Row): GuestVerificationReceipt {
  return guestVerificationReceiptSchema.parse({
    notificationId: row.id,
    businessKey: row.business_key,
    status: row.status,
    code: row.code,
    reference: row.reference,
    attemptedAt: row.attempted_at?.toISOString() ?? null,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
  });
}

/** A row that never reached a sender may be tried again under its key: nothing was sent. */
const RETRYABLE: readonly (GuestVerificationCode | null)[] = ['guest.notification_unconfigured', 'guest.address_rate_limited'];

export interface GuestVerificationOptions {
  /** The customer app origin the link must open. Blank refuses every send. */
  readonly origin: string | null | undefined;
  /** False while out-of-app sending is switched off: refused as no sender. */
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
  readonly addressMaxPerWindow?: number;
  readonly addressWindowMs?: number;
  readonly now?: () => Date;
}

export class GuestVerificationService {
  constructor(
    private readonly sql: Sql,
    private readonly sender: GuestMailSender,
    private readonly options: GuestVerificationOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async expire(tx: Sql, producer: Producer, businessKey: string): Promise<void> {
    await tx`UPDATE notify.guest_verifications SET status = 'unresolved', code = 'guest.acceptance_unknown', lease_until = NULL,
      updated_at = now()
      WHERE producer = ${producer} AND business_key = ${businessKey} AND status = 'attempting' AND lease_until <= clock_timestamp()`;
  }

  async send(producer: Producer, raw: GuestVerificationSendInput): Promise<GuestVerificationReceipt> {
    const input = guestVerificationSendInputSchema.parse(raw);
    const origin = this.options.origin?.trim() ?? '';
    const requestId = input.guestRequestId.toLowerCase();
    const timeoutMs = this.options.timeoutMs ?? 5000;
    const leaseMs = 2 * timeoutMs + 1000;
    let prepared: { row: Row; attempt: boolean };
    try {
      prepared = await transaction(
        this.sql,
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest-verify:${producer}:${requestId}`}, 0))`;
          const erased = await tx`SELECT 1 FROM notify.guest_verification_erasures
            WHERE producer = ${producer} AND guest_request_id = ${requestId}`;
          if (erased.length) throw new GuestVerificationError('guest.request_erased');
          await this.expire(tx, producer, input.businessKey);
          const [prior] = await tx<Row[]>`SELECT * FROM notify.guest_verifications
            WHERE producer = ${producer} AND business_key = ${input.businessKey}`;
          if (prior && prior.fingerprint !== fingerprint(input)) throw new GuestVerificationError('guest.request_conflict');
          if (
            prior &&
            !(prior.status === 'queued' || (prior.status === 'refused' && prior.attempted_at === null && RETRYABLE.includes(prior.code)))
          )
            return { row: prior, attempt: false };
          // Before anything is written or tried: the link opens the customer app, and is still good. A send already made
          // answered above, whatever the link's origin or expiry is now.
          if (origin === '') throw new GuestVerificationError('guest.link_origin_unset');
          if (!guestVerificationLinkMatches(input.link, origin)) throw new GuestVerificationError('guest.link_origin_mismatch');
          if (Date.parse(input.expiresAt) <= this.now().getTime()) throw new GuestVerificationError('guest.link_expired');
          let row = prior;
          if (!row) {
            [row] = await tx<Row[]>`INSERT INTO notify.guest_verifications
              (producer, business_key, fingerprint, guest_request_id, recipient_email, token_id, expires_at, status)
              VALUES (${producer}, ${input.businessKey}, ${fingerprint(input)}, ${requestId}, ${input.recipientEmail},
                ${input.tokenId}, ${input.expiresAt}, 'queued')
              RETURNING *`;
          }
          if (this.sender.notConnected !== null || this.options.enabled === false) {
            [row] = await tx<Row[]>`UPDATE notify.guest_verifications SET status = 'refused', code = 'guest.notification_unconfigured',
              updated_at = now() WHERE id = ${row!.id} RETURNING *`;
            return { row: row!, attempt: false };
          }
          const addressHash = createHash('sha256').update(`guest-verify:${input.recipientEmail.toLowerCase()}`).digest('hex');
          const windowMs = this.options.addressWindowMs ?? 900000;
          await tx`DELETE FROM notify.guest_verification_rate_windows
            WHERE address_hash = ${addressHash} AND window_start < floor(extract(epoch FROM clock_timestamp()) * 1000 / ${windowMs})::bigint - 1`;
          const budget = await tx`INSERT INTO notify.guest_verification_rate_windows (address_hash, window_start, attempts)
            VALUES (${addressHash}, floor(extract(epoch FROM clock_timestamp()) * 1000 / ${windowMs})::bigint, 1)
            ON CONFLICT (address_hash, window_start) DO UPDATE SET attempts = guest_verification_rate_windows.attempts + 1
            WHERE guest_verification_rate_windows.attempts < ${this.options.addressMaxPerWindow ?? 3}
            RETURNING attempts`;
          if (!budget.length) {
            [row] = await tx<Row[]>`UPDATE notify.guest_verifications SET status = 'refused', code = 'guest.address_rate_limited',
              updated_at = now() WHERE id = ${row!.id} RETURNING *`;
            return { row: row!, attempt: false };
          }
          [row] = await tx<Row[]>`UPDATE notify.guest_verifications SET status = 'attempting', code = NULL,
            attempted_at = clock_timestamp(), claim_token = ${randomUUID()},
            lease_until = clock_timestamp() + ${leaseMs} * interval '1 millisecond', updated_at = now()
            WHERE id = ${row!.id} RETURNING *`;
          return { row: row!, attempt: true };
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof GuestVerificationError) throw error;
      throw new GuestVerificationError('guest.storage_unavailable');
    }
    if (!prepared.attempt) return receipt(prepared.row);

    const t = createTranslator('en', undefined, { mode: 'prod' });
    let status: 'accepted' | 'refused' | 'unresolved';
    let code: GuestVerificationCode | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The lease outlives two deadlines; a claim that cannot finish inside it is left unresolved, never sent late.
      if (prepared.row.lease_until && prepared.row.lease_until.getTime() - Date.now() < timeoutMs) throw new Error('lease too short');
      const outcome = await Promise.race([
        this.sender.send({
          to: input.recipientEmail,
          subject: t.tUnsafe('notify.support.guest_verify.title'),
          text: t.tUnsafe('notify.support.guest_verify.body', { link: input.link, expiresAt: new Date(input.expiresAt).toISOString() }),
          transportKey: `guest-verify-v1:${createHash('sha256').update(`${producer}:${input.businessKey}`).digest('hex')}`,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('guest verification mail deadline')), timeoutMs);
        }),
      ]);
      if (outcome === 'accepted') status = 'accepted';
      else if (outcome === 'refused') [status, code] = ['refused', 'guest.gateway_refused'];
      else [status, code] = ['unresolved', 'guest.acceptance_unknown'];
    } catch {
      [status, code] = ['unresolved', 'guest.acceptance_unknown'];
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      const [finished] = await this.sql<Row[]>`UPDATE notify.guest_verifications SET status = ${status}, code = ${code},
        accepted_at = CASE WHEN ${status} = 'accepted' THEN greatest(attempted_at, clock_timestamp()) ELSE NULL END,
        lease_until = NULL, updated_at = now()
        WHERE id = ${prepared.row.id} AND claim_token = ${prepared.row.claim_token} AND status = 'attempting'
        RETURNING *`;
      return finished ? receipt(finished) : (await this.get(producer, { businessKey: input.businessKey }))!;
    } catch {
      throw new GuestVerificationError('guest.storage_unavailable');
    }
  }

  async get(producer: Producer, raw: { businessKey: string }): Promise<GuestVerificationReceipt | null> {
    const input = guestVerificationGetInputSchema.parse(raw);
    try {
      await this.expire(this.sql, producer, input.businessKey);
      const [row] = await this.sql<Row[]>`SELECT * FROM notify.guest_verifications
        WHERE producer = ${producer} AND business_key = ${input.businessKey}`;
      return row ? receipt(row) : null;
    } catch {
      throw new GuestVerificationError('guest.storage_unavailable');
    }
  }

  /** Erase the address of every row for one guest request and keep a tombstone. Erasing again answers the first erasure. */
  async erase(producer: Producer, raw: { guestRequestId: string }): Promise<GuestVerificationEraseReceipt> {
    const requestId = guestVerificationEraseInputSchema.parse(raw).guestRequestId.toLowerCase();
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.guest-verify:${producer}:${requestId}`}, 0))`;
          const [previous] = await tx<{ erased_count: number; erased_at: Date }[]>`SELECT erased_count, erased_at
            FROM notify.guest_verification_erasures WHERE producer = ${producer} AND guest_request_id = ${requestId}`;
          if (previous)
            return guestVerificationEraseReceiptSchema.parse({
              guestRequestId: requestId,
              erasedCount: previous.erased_count,
              erasedAt: previous.erased_at.toISOString(),
            });
          // A send still in flight would mail an address the guest asked to forget: wait for it.
          const busy = await tx`SELECT 1 FROM notify.guest_verifications WHERE producer = ${producer}
            AND guest_request_id = ${requestId} AND status = 'attempting' AND lease_until > clock_timestamp()`;
          if (busy.length) throw new GuestVerificationError('guest.delivery_in_progress');
          await tx`UPDATE notify.guest_verifications SET status = 'unresolved', code = 'guest.acceptance_unknown', lease_until = NULL,
            updated_at = now() WHERE producer = ${producer} AND guest_request_id = ${requestId} AND status = 'attempting'`;
          const erased =
            await tx`UPDATE notify.guest_verifications SET recipient_email = NULL, fingerprint = 'erased', erased_at = now(), updated_at = now()
            WHERE producer = ${producer} AND guest_request_id = ${requestId} AND erased_at IS NULL RETURNING id`;
          const [stone] = await tx<{ erased_at: Date }[]>`INSERT INTO notify.guest_verification_erasures
            (producer, guest_request_id, erased_count) VALUES (${producer}, ${requestId}, ${erased.length}) RETURNING erased_at`;
          return guestVerificationEraseReceiptSchema.parse({
            guestRequestId: requestId,
            erasedCount: erased.length,
            erasedAt: stone!.erased_at.toISOString(),
          });
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      if (error instanceof GuestVerificationError) throw error;
      throw new GuestVerificationError('guest.storage_unavailable');
    }
  }
}
