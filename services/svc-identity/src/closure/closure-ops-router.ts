/**
 * Founder desk view of closure requests. Read only.
 * No operator cancel, finalise, or reopen exists on this router.
 */
import { z } from 'zod';
import type { Context } from '@intafaced/contracts';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { userCopy } from '../user-copy.js';

export const IDENTITY_CLOSURE_LIST_LIMIT_UNSET = 'identity.closure_list_limit_unset' as const;
export const IDENTITY_CLOSURE_LIST_CURSOR_INVALID = 'identity.closure_list_cursor_invalid' as const;
export const CLOSURE_LIST_LIMIT_MAX = 200;

const STATUSES = ['requested', 'cancelled', 'blocked', 'closed'] as const;
type Status = (typeof STATUSES)[number];

export class ClosureListError extends Error {
  constructor(readonly code: typeof IDENTITY_CLOSURE_LIST_LIMIT_UNSET | typeof IDENTITY_CLOSURE_LIST_CURSOR_INVALID) {
    super(userCopy(code));
    this.name = 'ClosureListError';
  }
}

export type ClosureDeskRow = {
  userId: string;
  handle: string;
  status: Status;
  requestedAt: string;
  effectiveAt: string;
  blockerCodes: string[];
};

type SqlRow = {
  id: string;
  user_id: string;
  handle: string;
  status: Status;
  requested_at: Date;
  effective_at: Date;
  blockers: unknown;
};

function publishedLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > CLOSURE_LIST_LIMIT_MAX) {
    throw new ClosureListError(IDENTITY_CLOSURE_LIST_LIMIT_UNSET);
  }
  return value;
}

function codesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const code = (item as { code?: unknown }).code;
    if (typeof code === 'string' && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function encodeCursor(row: { requestedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.requestedAt.toISOString(), id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ClosureListError(IDENTITY_CLOSURE_LIST_CURSOR_INVALID);
  }
  if (!parsed || typeof parsed !== 'object') throw new ClosureListError(IDENTITY_CLOSURE_LIST_CURSOR_INVALID);
  const row = parsed as { at?: unknown; id?: unknown };
  if (typeof row.at !== 'string' || typeof row.id !== 'string') throw new ClosureListError(IDENTITY_CLOSURE_LIST_CURSOR_INVALID);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) {
    throw new ClosureListError(IDENTITY_CLOSURE_LIST_CURSOR_INVALID);
  }
  const at = new Date(row.at);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== row.at) throw new ClosureListError(IDENTITY_CLOSURE_LIST_CURSOR_INVALID);
  return { at, id: row.id.toLowerCase() };
}

function present(row: SqlRow): ClosureDeskRow {
  return {
    userId: row.user_id,
    handle: row.handle,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    effectiveAt: row.effective_at.toISOString(),
    blockerCodes: codesOf(row.blockers),
  };
}

export async function listAccountClosures(
  sql: Sql,
  input: { status?: Status | undefined; limit?: number | null | undefined; cursor?: string | undefined },
): Promise<{ rows: ClosureDeskRow[]; nextCursor: string | null }> {
  const limit = publishedLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const status = input.status ?? null;
  const rows = await sql<SqlRow[]>`
    SELECT c.id, c.user_id, u.handle, c.status, c.requested_at, c.effective_at, c.blockers
    FROM account_closures c
    JOIN users u ON u.id = c.user_id
    WHERE (${status}::text IS NULL OR c.status = ${status})
      AND (
        ${cursor?.at ?? null}::timestamptz IS NULL
        OR (c.requested_at, c.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    ORDER BY c.requested_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit && page.length > 0
      ? encodeCursor({ requestedAt: page[page.length - 1]!.requested_at, id: page[page.length - 1]!.id })
      : null;
  return { rows: page.map(present), nextCursor };
}

function toTrpc(err: unknown): never {
  if (err instanceof ClosureListError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  throw err;
}

const rowOut = z.object({
  userId: z.string().uuid(),
  handle: z.string(),
  status: z.enum(STATUSES),
  requestedAt: z.string(),
  effectiveAt: z.string(),
  blockerCodes: z.array(z.string()),
});

export function createClosureOpsRouter(sql: Sql) {
  return router({
    accountClosures: router({
      list: scopedProcedure('admin:compliance')
        .input(
          z
            .object({
              status: z.enum(STATUSES).optional(),
              limit: z.number().int().nullable().optional(),
              cursor: z.string().max(512).optional(),
            })
            .strict(),
        )
        .output(z.object({ rows: z.array(rowOut), nextCursor: z.string().nullable() }))
        .query(async ({ input }) => {
          try {
            return await listAccountClosures(sql, input);
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}

export function closureDeskDenied(ctx: Context): boolean {
  return ctx.principal === null || !ctx.principal.scopes.includes('admin:compliance');
}
