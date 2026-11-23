/**
 * Support's read of one customer's API keys and calls (J-developer-17, DV-errors-02, DV-keys-06), mounted from its records
 * (`@intafaced/contracts/identity-developer-support-procedures`).
 *
 * A support agent reads, for one account only, its keys as the owner's own list shows them (`KEY_COLUMNS`: never the hash
 * or a secret), and its keys' call log: metadata and the typed error code the reply carried, never a body. A request id
 * narrows the log to that one call; a request id no key of this account made, another account's included, is refused not
 * found, exactly as one that never existed. Each read first writes one operator read audit row (the reader and a hash of
 * what was asked), so nothing is read unaudited, and a refused read stays audited.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Context } from '@intafaced/contracts';
import { TRPCError } from '@intafaced/contracts/trpc';
import {
  DEVELOPER_SUPPORT_KEY_NOT_FOUND,
  DEVELOPER_SUPPORT_REQUEST_NOT_FOUND,
  IDENTITY_DEVELOPER_SUPPORT_PROCEDURES,
  type DeveloperSupportCalls,
  type DeveloperSupportCallsInput,
  type DeveloperSupportKeys,
} from '@intafaced/contracts/identity-developer-support-procedures';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { KEY_COLUMNS, toRecord } from '../auth/developer-keys.js';

type Code = typeof DEVELOPER_SUPPORT_REQUEST_NOT_FOUND | typeof DEVELOPER_SUPPORT_KEY_NOT_FOUND;

export class DeveloperSupportError extends Error {
  constructor(
    message: string,
    readonly code: Code,
  ) {
    super(message);
    this.name = 'DeveloperSupportError';
  }
}

/** The columns `KEY_COLUMNS` reads, checked as they arrive. */
const KeyRow = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  mode: z.string(),
  scopes: z.array(z.string()),
  ip_allowlist: z.array(z.string()).nullable(),
  require_signature: z.boolean().nullable(),
  created_at: z.date(),
  expires_at: z.date().nullable(),
  last_used_at: z.date().nullable(),
  revoked: z.boolean(),
  revoked_at: z.date().nullable(),
  revoked_cause: z.string().nullable(),
  revoke_reason: z.string().nullable(),
  account_id: z.string().nullable(),
  kind: z.string().nullable(),
});

const CallRow = z.object({
  request_id: z.string(),
  key_id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
  error_code: z.string().nullable(),
  outside_ip_list: z.boolean(),
  called_at: z.date(),
});

const OwnedRow = z.object({ id: z.string() });

function reader(ctx: Context): string {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in first' });
  return ctx.principal.userId;
}

const hash = (...parts: readonly string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

interface Audit {
  readonly actorId: string;
  readonly kind: 'developer_keys' | 'developer_calls';
  readonly queryHash: string;
}

async function audit(sql: Sql, { actorId, kind, queryHash }: Audit) {
  await sql`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actorId}, ${kind}, ${queryHash})
  `;
}

export interface SupportRead<I> {
  readonly actorId: string;
  readonly input: I;
  readonly now?: Date;
}

export async function supportKeys(
  sql: Sql,
  { actorId, input, now = new Date() }: SupportRead<{ userId: string; limit: number }>,
): Promise<DeveloperSupportKeys> {
  await audit(sql, { actorId, kind: 'developer_keys', queryHash: hash(input.userId) });
  const rows = KeyRow.array().parse(
    await sql`
      SELECT ${sql.unsafe(KEY_COLUMNS)}
      FROM api_keys WHERE user_id = ${input.userId} ORDER BY created_at DESC, id DESC LIMIT ${input.limit}
    `,
  );
  return {
    asOf: now.toISOString(),
    keys: rows.map((row) => {
      const { id, name, prefix, mode, kind, scopes, ipAllowlist, createdAt, expiresAt, lastUsedAt, revoked, revokedAt, revokedBy } =
        toRecord(row);
      return { id, name, prefix, mode, kind, scopes, ipAllowlist, createdAt, expiresAt, lastUsedAt, revoked, revokedAt, revokedBy };
    }),
  };
}

export async function supportCalls(
  sql: Sql,
  { actorId, input, now = new Date() }: SupportRead<DeveloperSupportCallsInput>,
): Promise<DeveloperSupportCalls> {
  const requestId = input.requestId?.trim();
  // Written first, so a read that is then refused not found is audited too.
  await audit(sql, { actorId, kind: 'developer_calls', queryHash: hash(input.userId, requestId ?? '', input.keyId ?? '') });
  if (input.keyId !== undefined) {
    const owned = OwnedRow.array().parse(await sql`SELECT id FROM api_keys WHERE id = ${input.keyId} AND user_id = ${input.userId}`);
    if (!owned[0]) throw new DeveloperSupportError('No key with this id on this account', DEVELOPER_SUPPORT_KEY_NOT_FOUND);
  }
  const rows = CallRow.array().parse(
    await sql`
      SELECT c.request_id, c.key_id, k.name, k.key_prefix, c.method, c.path, c.status, c.error_code, c.outside_ip_list, c.called_at
      FROM api_key_calls c JOIN api_keys k ON k.id = c.key_id
      WHERE k.user_id = ${input.userId}
        ${requestId === undefined ? sql`` : sql`AND c.request_id = ${requestId}`}
        ${input.keyId === undefined ? sql`` : sql`AND c.key_id = ${input.keyId}`}
      ORDER BY c.called_at DESC, c.request_id
      LIMIT ${input.limit}
    `,
  );
  if (requestId !== undefined && rows.length === 0) {
    throw new DeveloperSupportError('No call of this account has this request id', DEVELOPER_SUPPORT_REQUEST_NOT_FOUND);
  }
  return {
    asOf: now.toISOString(),
    calls: rows.map((row) => ({
      requestId: row.request_id,
      keyId: row.key_id,
      keyName: row.name,
      keyPrefix: row.key_prefix,
      method: row.method,
      path: row.path,
      status: row.status,
      errorCode: row.error_code,
      outsideIpList: row.outside_ip_list,
      at: row.called_at.toISOString(),
    })),
  };
}

const refusal: RefusalOf = (err) =>
  err instanceof DeveloperSupportError
    ? { code: err.code, error: new TRPCError({ code: 'NOT_FOUND', message: `${err.message} [${err.code}]`, cause: err }) }
    : undefined;

/** `developerSupport.keys` and `developerSupport.calls`, from their records. */
export function createDeveloperSupportRouter(sql: Sql) {
  return mountRecords(
    IDENTITY_DEVELOPER_SUPPORT_PROCEDURES,
    {
      'identity.developerSupport.keys': ({ ctx, input }) => supportKeys(sql, { actorId: reader(ctx), input }),
      'identity.developerSupport.calls': ({ ctx, input }) => supportCalls(sql, { actorId: reader(ctx), input }),
    },
    refusal,
  );
}
