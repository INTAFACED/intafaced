import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';

/** The name the account page shows for what a key is. */
const connectedApp = z.object({
  id: z.string().guid(),
  kind: z.literal('api-key'),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  mode: z.enum(['live', 'sandbox']),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  originAllowlist: z.array(z.string()),
  ipAllowlist: z.array(z.string()),
});

type Row = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  mode: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  domain_whitelist: string[] | null;
  ip_allowlist: string[] | null;
};

/**
 * Connected apps and API access. Only the caller's own live API keys are listed. No third-party
 * app can be authorised yet, so there are no OAuth grants and the answer says that instead of
 * showing an empty list that could be read as "none yet". Revoke goes through the same row update
 * as `apiKeys.revoke`, scoped to the caller, so another account's key looks like a key that does not exist.
 */
export function createGrantsRouter(sql: Sql) {
  return router({
    grants: router({
      list: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }).strict())
        .output(
          z
            .object({
              apps: z.array(connectedApp),
              oauth: z.object({
                grants: z.array(z.never()),
                available: z.literal(false),
                reason: z.literal('no-third-party-app-can-be-authorised'),
              }),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) => {
          const rows = await sql<Row[]>`
            SELECT id, name, key_prefix, scopes, mode, created_at, last_used_at, expires_at, domain_whitelist, ip_allowlist
            FROM api_keys
            WHERE user_id = ${ctx.principal.userId} AND revoked = false
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY created_at DESC
            LIMIT ${input.limit}
          `;
          return {
            apps: rows.map((row) => ({
              id: row.id,
              kind: 'api-key' as const,
              name: row.name,
              prefix: row.key_prefix,
              scopes: row.scopes,
              mode: row.mode === 'sandbox' ? ('sandbox' as const) : ('live' as const),
              createdAt: row.created_at.toISOString(),
              lastUsedAt: row.last_used_at?.toISOString() ?? null,
              expiresAt: row.expires_at?.toISOString() ?? null,
              originAllowlist: row.domain_whitelist ?? [],
              ipAllowlist: row.ip_allowlist ?? [],
            })),
            oauth: { grants: [], available: false as const, reason: 'no-third-party-app-can-be-authorised' as const },
          };
        }),

      revoke: scopedProcedure('identity:write')
        .input(z.object({ keyId: z.string().guid() }).strict())
        .output(z.object({ keyId: z.string().guid(), revoked: z.literal(true), alreadyRevoked: z.boolean() }).strict())
        .mutation(async ({ ctx, input }) => {
          const updated = await sql`
            UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'owner'
            WHERE id = ${input.keyId} AND user_id = ${ctx.principal.userId} AND revoked = false
          `;
          if (updated.count > 0) return { keyId: input.keyId, revoked: true as const, alreadyRevoked: false };
          const [own] = await sql`SELECT 1 FROM api_keys WHERE id = ${input.keyId} AND user_id = ${ctx.principal.userId}`;
          if (!own) throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.not_found' });
          return { keyId: input.keyId, revoked: true as const, alreadyRevoked: true };
        }),
    }),
  });
}
