/**
 * A key's call log (DV-keys-06, J-developer-08): what the key did, as the edge answered it.
 *
 * The edge reports each call it answered for an API key (`developerKeys.recordCall`). The key is found by its hash,
 * whether or not it is still live, so a revoked key's refused calls are on its log too. An unknown hash records
 * nothing. A row keeps the method, the path without its query, the status the edge answered and whether the caller's
 * address was outside the key's IP list at that moment; the address itself is never stored, and neither is any body or
 * header value. The edge's request id is the business key: a report sent twice writes one row.
 *
 * Only the key's owner reads its log (`developerKeys.calls`); anyone else's key is not found.
 */
import type { Sql } from 'postgres';
import type { ApiKeyCallRecordInput, ApiKeyCallRecordOutput, ApiKeyCallsInput, ApiKeyCallsOutput } from '@intafaced/contracts/api-keys';
import { apiKeyIpAllowed } from './api-key-ip.js';

export class ApiKeyCallsError extends Error {
  constructor(
    message: string,
    readonly code: 'identity.key_not_found',
  ) {
    super(message);
    this.name = 'ApiKeyCallsError';
  }
}

export async function recordApiKeyCall(sql: Sql, input: ApiKeyCallRecordInput): Promise<ApiKeyCallRecordOutput> {
  const keys = await sql<Array<{ id: string; ip_allowlist: string[] | null }>>`
    SELECT id, ip_allowlist FROM api_keys WHERE key_hash = ${input.keyHash}
  `;
  const key = keys[0];
  if (!key) return { recorded: false };
  const allowlist = key.ip_allowlist ?? [];
  const outside = allowlist.length > 0 && !apiKeyIpAllowed(allowlist, input.clientIp);
  const path = input.path.split('?')[0]!;
  await sql`
    INSERT INTO api_key_calls (request_id, key_id, method, path, status, outside_ip_list, called_at)
    VALUES (${input.requestId}, ${key.id}, ${input.method.toUpperCase()}, ${path}, ${input.status}, ${outside}, ${input.at})
    ON CONFLICT (request_id) DO NOTHING
  `;
  return { recorded: true };
}

type CallRow = { request_id: string; method: string; path: string; status: number; outside_ip_list: boolean; called_at: Date };

/** One UTC day as `[start, end)`; `to` is inclusive, so its end is the next day's start. */
function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function listApiKeyCalls(
  sql: Sql,
  userId: string,
  input: ApiKeyCallsInput,
  now: Date = new Date(),
): Promise<ApiKeyCallsOutput> {
  const owned = await sql<Array<{ id: string }>>`SELECT id FROM api_keys WHERE id = ${input.keyId} AND user_id = ${userId}`;
  if (!owned[0]) throw new ApiKeyCallsError('API key not found', 'identity.key_not_found');
  const from = input.from ? dayStart(input.from) : null;
  const until = input.to ? new Date(dayStart(input.to).getTime() + 86_400_000) : null;
  const rows = await sql<CallRow[]>`
    SELECT request_id, method, path, status, outside_ip_list, called_at
    FROM api_key_calls
    WHERE key_id = ${input.keyId}
      ${input.status === undefined ? sql`` : sql`AND status = ${input.status}`}
      ${from === null ? sql`` : sql`AND called_at >= ${from}`}
      ${until === null ? sql`` : sql`AND called_at < ${until}`}
    ORDER BY called_at DESC, request_id
    LIMIT ${input.limit}
  `;
  return {
    keyId: input.keyId,
    asOf: now.toISOString(),
    calls: rows.map((row) => ({
      requestId: row.request_id,
      method: row.method,
      path: row.path,
      status: row.status,
      outsideIpList: row.outside_ip_list,
      at: row.called_at.toISOString(),
    })),
  };
}
