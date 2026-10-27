/**
 * Mail another service asks identity to send to a customer (`POST /internal/mail`, `serviceMailRequestSchema`). Identity
 * holds the address, so the caller names the account and identity mails its own proved address; the caller never sees
 * it. Each purpose has one link shape (built in the mail transport from the token) and one service allowed to ask.
 *
 * The caller's business key is unique in the outbox: a retry with the same body answers with the first mail and sends
 * nothing more, and a retry with a different body is refused, so a crash between "asked" and "answered" on either side
 * never sends a second link. The token rides in the row's `code` until the relay hands the mail off, then it is cleared.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from 'postgres';
import {
  SERVICE_MAIL_PATH,
  serviceMailRequestSchema,
  type ServiceBodyBindMode,
  type ServiceMailAccepted,
  type ServiceMailPurpose,
  type ServiceMailRequest,
} from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';

/** The one service allowed to ask for each purpose. */
export const SERVICE_MAIL_CALLERS: Readonly<Record<ServiceMailPurpose, string>> = {
  'withdraw-address-approval': 'svc-bank',
};

/** The longest a link may be shown as valid for. */
const MAX_AHEAD_MS = 7 * 86_400_000;

export type ServiceMailRefusal =
  | 'identity.account_not_found'
  | 'identity.account_not_active'
  | 'identity.email_unproved'
  | 'identity.mail_key_conflict'
  | 'identity.mail_expiry_invalid'
  | 'identity.mail_unwired';

export class ServiceMailError extends Error {
  constructor(
    readonly code: ServiceMailRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceMailError';
  }
}

export interface ServiceMailDeps {
  readonly sql: Sql;
  readonly now: () => Date;
  /** Whether a mail transport is configured. Without one nothing can be delivered, so the request is refused. */
  readonly mailWired: boolean;
  /** Starts the relay after the row is committed. */
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

function bodyHash(input: ServiceMailRequest): string {
  const canonical = JSON.stringify([input.userId, input.purpose, input.token, input.detail ?? null, Date.parse(input.expiresAt)]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Queue the mail once per key. The answer names the outbox row; a repeat of the same request names the same row. */
export async function queueServiceMail(deps: ServiceMailDeps, input: ServiceMailRequest): Promise<ServiceMailAccepted> {
  const now = deps.now();
  const hash = bodyHash(input);
  // A repeat of a request already queued answers with its mail, whatever the clock or the transport says now.
  const repeat = async (tx: TransactionSql): Promise<string | null> => {
    const [prior] = await tx<Array<{ id: string; body_hash: string | null }>>`
      SELECT id, body_hash FROM mail_outbox WHERE dedupe_key = ${input.key}
    `;
    if (!prior) return null;
    if (prior.body_hash !== hash) {
      throw new ServiceMailError('identity.mail_key_conflict', 'this key was already used for a different mail');
    }
    return prior.id;
  };
  let created = false;
  const mailId = await deps.sql.begin(async (tx) => {
    const prior = await repeat(tx);
    if (prior) return prior;
    if (!deps.mailWired) throw new ServiceMailError('identity.mail_unwired', 'no mail transport is configured');
    const expiresAt = new Date(input.expiresAt);
    if (!(expiresAt.getTime() > now.getTime()) || expiresAt.getTime() - now.getTime() > MAX_AHEAD_MS) {
      throw new ServiceMailError('identity.mail_expiry_invalid', 'expiresAt must be in the future and at most seven days ahead');
    }
    const [user] = await tx<Array<{ status: string; email: string | null; email_verified_at: Date | null }>>`
      SELECT status, email, email_verified_at FROM users WHERE id = ${input.userId}
    `;
    if (!user) throw new ServiceMailError('identity.account_not_found', 'account not found');
    if (user.status !== 'active') throw new ServiceMailError('identity.account_not_active', 'the account is not active');
    if (!user.email || !user.email_verified_at) {
      throw new ServiceMailError('identity.email_unproved', 'the account has no proved email address');
    }
    // The unique key settles a race between two retries: the loser inserts nothing and reads the winner's row.
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, detail, expires_at, status, created_at)
      VALUES (
        NULL, ${input.userId}, ${input.key}, ${hash}, ${input.purpose}, ${user.email}, ${input.token}, ${input.detail ?? null},
        ${expiresAt}, 'pending', ${now}
      )
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id
    `;
    if (!row) return (await repeat(tx))!;
    created = true;
    return row.id;
  });
  if (created) await deps.afterCommit?.();
  return { accepted: true, mailId };
}

const STATUS: Readonly<Record<ServiceMailRefusal, number>> = {
  'identity.account_not_found': 404,
  'identity.account_not_active': 409,
  'identity.email_unproved': 409,
  'identity.mail_key_conflict': 409,
  'identity.mail_expiry_invalid': 400,
  'identity.mail_unwired': 503,
};

export function registerServiceMailRoute(
  app: FastifyInstance,
  opts: {
    queue: (input: ServiceMailRequest) => Promise<ServiceMailAccepted>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(SERVICE_MAIL_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    const parsed = serviceMailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid mail request', code: 'identity.mail_request_invalid' });
    }
    if (SERVICE_MAIL_CALLERS[parsed.data.purpose] !== service) {
      return reply.code(403).send({ error: 'this service may not send this mail', code: 'identity.mail_caller_refused' });
    }
    try {
      return await opts.queue(parsed.data);
    } catch (error) {
      if (error instanceof ServiceMailError) {
        return reply.code(STATUS[error.code]).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
