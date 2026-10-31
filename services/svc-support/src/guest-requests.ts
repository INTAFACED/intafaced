/**
 * Guest support requests (SP-tickets-01, J-support-public-03).
 *
 * A person with no account submits a request with an email address. The request is stored, and svc-notify's guest
 * verification door is asked to mail a one-time link (ADR 2026-10-22 §3.5). No ticket exists until the link is used; the
 * first use opens it under the owner id `guest:<request id>` with the business key `guest-verify:<request id>`, so the same
 * link used again opens the same ticket. Using the link also hands back an access token for that one request: it reads and
 * replies there and nowhere else, and no other call takes it as a session.
 *
 * Write first, then send. The row and its token hash are committed before the door is called; an unknown answer keeps the
 * row (`delivery_unknown`) and is never sent again under that key. A row still waiting for a sender is retried by the same
 * submission (same client key) under the next ordinal, with a fresh token.
 *
 * Owner values, each blank by default and refused by name: the link lifetime, the per-address rate and its window, how
 * long a guest's address is kept, and the key the address is sealed with. No sender or no customer origin refuses
 * `vendor.email` and keeps the request pending.
 */
import { createCipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  guestVerificationKey,
  supportGuestCreateInputSchema,
  supportGuestReplyInputSchema,
  supportGuestThreadInputSchema,
  supportGuestVerifyInputSchema,
  supportTicketCategorySchema,
  SUPPORT_CATEGORY_UNKNOWN,
  SUPPORT_GUEST_ADDRESS_KEY_UNSET,
  SUPPORT_GUEST_DELIVERY_UNKNOWN,
  SUPPORT_GUEST_LINK_EXPIRED,
  SUPPORT_GUEST_LINK_INVALID,
  SUPPORT_GUEST_LINK_TTL_UNSET,
  SUPPORT_GUEST_RATE_LIMITED,
  SUPPORT_GUEST_RATE_LIMIT_UNSET,
  SUPPORT_GUEST_RETENTION_UNSET,
  SUPPORT_GUEST_VERIFY_PATH,
  type SupportComment,
  type SupportGuestCreateResult,
  type SupportGuestThread,
  type SupportGuestVerifyResult,
  type SupportTicket,
  type SupportTicketCategory,
} from '@intafaced/contracts';
import { GuestVerificationRefusal, type GuestVerificationDoor } from './guest-verification-client.js';
import { SupportError } from './support-service.js';

/** The part of the support service a guest request uses: the same create, read and reply as a signed-in person. */
export interface GuestTicketDesk {
  categories(): Promise<{ categories: readonly { id: SupportTicketCategory; refusal: string | null }[] }>;
  createTicket(input: {
    userId: string;
    category: SupportTicketCategory;
    subject: string;
    body: string;
    clientRequestId: string;
  }): Promise<SupportTicket>;
  getTicket(input: { userId: string; ticketId: string }): Promise<SupportTicket>;
  listComments(input: { userId: string; ticketId: string; limit: number }): Promise<SupportComment[]>;
  comment(input: { userId: string; ticketId: string; body: string; clientRequestId: string }): Promise<SupportComment>;
}

export interface GuestRequestSettings {
  /** How long a verification link works. */
  readonly linkTtlMinutes: number | null;
  /** Sends per address per window. */
  readonly rateLimit: number | null;
  readonly rateWindowSeconds: number | null;
  /** How long a guest's address and access link are kept. */
  readonly retentionDays: number | null;
  /** 32 bytes as 64 hex characters: seals the address for sending. */
  readonly addressKey: string | null;
  /** The customer app's origin, which the links open. */
  readonly publicOrigin: string | null;
}

type Row = {
  id: string;
  fingerprint: string;
  address_sealed: string | null;
  category: SupportTicketCategory;
  subject: string;
  body: string;
  status: 'pending_delivery' | 'sent' | 'delivery_unknown' | 'verified';
  send_ordinal: number;
  token_id: string | null;
  token_hash: string | null;
  token_expires_at: Date | null;
  ticket_id: string | null;
  access_id: string | null;
  access_hash: string | null;
  access_expires_at: Date | null;
  erase_after: Date;
  erased_at: Date | null;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const addressHashOf = (email: string) => sha256(`support-guest:${email.trim().toLowerCase()}`);
const ownerOf = (requestId: string) => `guest:${requestId}`;

/** A one-time token: an id to find the row and a secret whose hash is kept. */
function mintToken(): { id: string; secret: string; token: string; hash: string } {
  const id = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, token: `${id}.${secret}`, hash: sha256(secret) };
}

function splitToken(token: string): { id: string; secret: string } {
  const [id = '', secret = ''] = token.split('.');
  return { id, secret };
}

function hashMatches(secret: string, stored: string | null): boolean {
  if (stored === null) return false;
  const a = Buffer.from(sha256(secret), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function seal(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

const linkInvalid = () => new SupportError('that link does not open a request', SUPPORT_GUEST_LINK_INVALID);
const linkExpired = () => new SupportError('that link has expired', SUPPORT_GUEST_LINK_EXPIRED);
const notConnected = () => new SupportError('a verification email needs an email sender', 'vendor.email');

export class GuestRequests {
  constructor(
    private readonly sql: Sql,
    private readonly desk: GuestTicketDesk,
    private readonly door: GuestVerificationDoor,
    private readonly settings: GuestRequestSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Each owner value the guest path needs, or the refusal naming the first one that is blank. */
  private values(): { ttlMs: number; rateLimit: number; windowMs: number; retentionMs: number; key: Buffer } {
    const s = this.settings;
    if (s.linkTtlMinutes === null)
      throw new SupportError('the guest link lifetime is not set', SUPPORT_GUEST_LINK_TTL_UNSET, 'SUPPORT_GUEST_LINK_TTL_MINUTES');
    if (s.rateLimit === null || s.rateWindowSeconds === null)
      throw new SupportError('the guest request limit is not set', SUPPORT_GUEST_RATE_LIMIT_UNSET, 'SUPPORT_GUEST_RATE_LIMIT');
    if (s.retentionDays === null)
      throw new SupportError('how long a guest address is kept is not set', SUPPORT_GUEST_RETENTION_UNSET, 'SUPPORT_GUEST_RETENTION_DAYS');
    if (s.addressKey === null || !/^[0-9a-fA-F]{64}$/.test(s.addressKey))
      throw new SupportError('no key seals a guest address', SUPPORT_GUEST_ADDRESS_KEY_UNSET, 'SUPPORT_GUEST_ADDRESS_KEY');
    return {
      ttlMs: s.linkTtlMinutes * 60_000,
      rateLimit: s.rateLimit,
      windowMs: s.rateWindowSeconds * 1000,
      retentionMs: s.retentionDays * 86_400_000,
      key: Buffer.from(s.addressKey, 'hex'),
    };
  }

  private origin(): string | null {
    try {
      return this.settings.publicOrigin ? new URL(this.settings.publicOrigin).origin : null;
    } catch {
      return null;
    }
  }

  async create(raw: unknown): Promise<SupportGuestCreateResult> {
    const input = supportGuestCreateInputSchema.parse(raw);
    const category = supportTicketCategorySchema.safeParse(input.category);
    if (!category.success) throw new SupportError('that category is not offered', SUPPORT_CATEGORY_UNKNOWN);
    const values = this.values();
    // A category that cannot be sent now (a fraud report with no compliance group) refuses before anything is stored.
    const offered = (await this.desk.categories()).categories.find((row) => row.id === category.data);
    if (offered?.refusal) throw new SupportError('that category cannot be sent now', offered.refusal);

    const addressHash = addressHashOf(input.email);
    const clientKey = sha256(`${addressHash}:${input.clientRequestId}`);
    const fingerprint = sha256(JSON.stringify([category.data, input.subject, input.body]));
    const token = mintToken();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + values.ttlMs);

    const prepared = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`support.guest:${clientKey}`}, 0))`;
      const [prior] = await tx<Row[]>`SELECT * FROM support.guest_requests WHERE client_key = ${clientKey}`;
      if (prior && prior.fingerprint !== fingerprint)
        throw new SupportError('that request key was already used for a different request', 'support.idempotency_conflict');
      if (prior && prior.status !== 'pending_delivery') return { row: prior, send: false };
      // Each new submission counts against the address; over the limit nothing is stored. A retry of a submission still
      // waiting for a sender is not a new one (svc-notify's own per-address window bounds the mail it sends).
      if (!prior) {
        const windowStart = Math.floor(at.getTime() / values.windowMs);
        await tx`DELETE FROM support.guest_rate_windows WHERE window_start < ${windowStart}`;
        const budget = await tx`INSERT INTO support.guest_rate_windows (address_hash, window_start, attempts)
          VALUES (${addressHash}, ${windowStart}, 1)
          ON CONFLICT (address_hash, window_start) DO UPDATE SET attempts = guest_rate_windows.attempts + 1
          WHERE guest_rate_windows.attempts < ${values.rateLimit}
          RETURNING attempts`;
        if (!budget.length) return { row: null, send: false };
      }
      let row = prior;
      if (!row) {
        [row] = await tx<Row[]>`INSERT INTO support.guest_requests
          (client_key, fingerprint, address_hash, address_sealed, category, subject, body, status, erase_after)
          VALUES (${clientKey}, ${fingerprint}, ${addressHash}, ${seal(values.key, input.email.trim())}, ${category.data},
            ${input.subject}, ${input.body}, 'pending_delivery', ${new Date(at.getTime() + values.retentionMs)})
          RETURNING *`;
      }
      [row] = await tx<Row[]>`UPDATE support.guest_requests SET send_ordinal = send_ordinal + 1, token_id = ${token.id},
        token_hash = ${token.hash}, token_expires_at = ${expiresAt}, delivery_code = NULL, updated_at = now()
        WHERE id = ${row!.id} RETURNING *`;
      return { row: row!, send: true };
    });
    if (prepared.row === null) throw new SupportError('too many requests from this address for now', SUPPORT_GUEST_RATE_LIMITED);
    const row = prepared.row;
    if (!prepared.send) return this.answer(row);

    const origin = this.origin();
    if (!this.door.configured || origin === null) {
      await this.settle(row, 'pending_delivery', 'vendor.email');
      throw notConnected();
    }
    let status: Row['status'] = 'delivery_unknown';
    let code: string | null = SUPPORT_GUEST_DELIVERY_UNKNOWN;
    try {
      const receipt = await this.door.send({
        businessKey: guestVerificationKey(row.id, row.send_ordinal),
        guestRequestId: row.id,
        recipientEmail: input.email.trim(),
        link: `${origin}${SUPPORT_GUEST_VERIFY_PATH}#token=${token.token}`,
        tokenId: token.id,
        expiresAt: expiresAt.toISOString(),
      });
      if (receipt?.status === 'accepted') [status, code] = ['sent', null];
      else if (
        receipt?.status === 'refused' &&
        (receipt.code === 'guest.notification_unconfigured' || receipt.code === 'guest.configuration_unverified')
      )
        [status, code] = ['pending_delivery', 'vendor.email'];
      else if (receipt?.status === 'refused' && receipt.attemptedAt === null) [status, code] = ['pending_delivery', receipt.code];
    } catch (error) {
      // A typed refusal before anything was sent (a link the door will not take): the request waits, nothing went out.
      if (error instanceof GuestVerificationRefusal) [status, code] = ['pending_delivery', error.code];
    }
    await this.settle(row, status, code);
    if (status === 'sent') return this.answer({ ...row, status });
    if (code === 'vendor.email') throw notConnected();
    if (status === 'delivery_unknown')
      throw new SupportError('the email may or may not have been sent; it is not sent again', SUPPORT_GUEST_DELIVERY_UNKNOWN);
    throw new SupportError('the verification email could not be sent', code ?? SUPPORT_GUEST_DELIVERY_UNKNOWN);
  }

  /** What a stored submission answers when it is sent again. */
  private answer(row: Row): SupportGuestCreateResult {
    if (row.status === 'delivery_unknown')
      throw new SupportError('the email may or may not have been sent; it is not sent again', SUPPORT_GUEST_DELIVERY_UNKNOWN);
    return { guestRequestId: row.id, state: 'check_email', linkExpiresAt: row.token_expires_at!.toISOString() };
  }

  private async settle(row: Row, status: Row['status'], code: string | null): Promise<void> {
    await this.sql`UPDATE support.guest_requests SET status = ${status}, delivery_code = ${code}, updated_at = now()
      WHERE id = ${row.id} AND send_ordinal = ${row.send_ordinal} AND status <> 'verified'`;
  }

  /** The emailed link: opens the ticket once, and answers the same ticket on every later use while the link works. */
  async verify(raw: unknown): Promise<SupportGuestVerifyResult> {
    const { id, secret } = splitToken(supportGuestVerifyInputSchema.parse(raw).token);
    const [found] = await this.sql<Row[]>`SELECT * FROM support.guest_requests WHERE token_id = ${id}`;
    if (!found || found.erased_at !== null || !hashMatches(secret, found.token_hash)) throw linkInvalid();
    if (found.token_expires_at === null || found.token_expires_at.getTime() <= this.now().getTime()) throw linkExpired();
    // The ticket's key is the request id, so a crash after it is made and before the row says so is mended by the next use.
    const ticket = await this.desk.createTicket({
      userId: ownerOf(found.id),
      category: found.category,
      subject: found.subject,
      body: found.body,
      clientRequestId: `guest-verify:${found.id}`,
    });
    const access = mintToken();
    const [row] = await this.sql<Row[]>`UPDATE support.guest_requests SET status = 'verified', ticket_id = ${ticket.id},
      access_id = ${access.id}, access_hash = ${access.hash}, access_expires_at = erase_after, updated_at = now()
      WHERE id = ${found.id} AND token_id = ${id} AND erased_at IS NULL RETURNING *`;
    if (!row) throw linkInvalid();
    return { ticketId: ticket.id, access: access.token, accessExpiresAt: row.access_expires_at!.toISOString() };
  }

  /** The one request an access token opens, or a refusal that reads the same for every other token. */
  private async accessed(token: string): Promise<{ owner: string; ticketId: string }> {
    const { id, secret } = splitToken(token);
    const [row] = await this.sql<Row[]>`SELECT * FROM support.guest_requests WHERE access_id = ${id}`;
    if (!row || row.erased_at !== null || row.ticket_id === null || !hashMatches(secret, row.access_hash)) throw linkInvalid();
    if (row.access_expires_at === null || row.access_expires_at.getTime() <= this.now().getTime()) throw linkExpired();
    return { owner: ownerOf(row.id), ticketId: row.ticket_id };
  }

  async thread(raw: unknown): Promise<SupportGuestThread> {
    const input = supportGuestThreadInputSchema.parse(raw);
    const { owner, ticketId } = await this.accessed(input.access);
    const ticket = await this.desk.getTicket({ userId: owner, ticketId });
    const comments = await this.desk.listComments({ userId: owner, ticketId, limit: input.limit });
    return { ticket, comments };
  }

  async reply(raw: unknown): Promise<SupportComment> {
    const input = supportGuestReplyInputSchema.parse(raw);
    const { owner, ticketId } = await this.accessed(input.access);
    return this.desk.comment({ userId: owner, ticketId, body: input.body, clientRequestId: input.clientRequestId });
  }

  /** Erase each guest address past its retention, here and in svc-notify. Returns how many were erased here. */
  async eraseDue(batch = 100): Promise<number> {
    if (this.settings.retentionDays === null) return 0;
    const due = await this.sql<{ id: string }[]>`SELECT id FROM support.guest_requests
      WHERE erased_at IS NULL AND erase_after <= ${this.now()} ORDER BY erase_after LIMIT ${batch}`;
    let erased = 0;
    for (const { id } of due) {
      // svc-notify forgets first; until it answers, the row keeps its address and the next pass asks again.
      if (this.door.configured && (await this.door.erase(id)) === null) continue;
      const done = await this.sql`UPDATE support.guest_requests SET address_sealed = NULL, token_hash = NULL, access_hash = NULL,
        erased_at = now(), updated_at = now() WHERE id = ${id} AND erased_at IS NULL`;
      erased += done.count;
    }
    return erased;
  }
}
