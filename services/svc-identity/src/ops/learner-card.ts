/**
 * J-academy-14 #1: one account as a support desk needs it, found by its exact email, exact handle or account id. The
 * handle, the email masked, the status and sign-up time, and sign-in statistics counted from identity's own sessions.
 * Nothing else leaves: no full email, device, address or token.
 *
 * `admin:read` on a signed-in, second-factor operator session (never an API key, a sub-account or a service call), so a
 * read-only support session can look a learner up; the account search with masked lists stays `admin:compliance`. Every
 * lookup is audited as a hash of the term, as the account search is. An exact match only: no prefix, no listing.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure, TRPCError, type Context } from '@intafaced/contracts';
import {
  identityLearnerCardInputSchema,
  identityLearnerCardResultSchema,
  type IdentityLearnerCard,
} from '@intafaced/contracts/identity-learner-card';
import { maskEmail } from './account-directory.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function reader(context: Context): string {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:read')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin:read is required [operator.denied]' });
  }
  if (principal.mfa !== true) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'A second factor is required [mfa.required]' });
  return principal.userId;
}

/** Exactly one of the three, as the operator typed it. */
export function learnerCardTerm(input: z.infer<typeof identityLearnerCardInputSchema>): { kind: 'email' | 'handle' | 'id'; value: string } {
  const terms = [
    input.email ? { kind: 'email' as const, value: input.email.trim().toLowerCase() } : null,
    input.handle ? { kind: 'handle' as const, value: input.handle.trim() } : null,
    input.userId ? { kind: 'id' as const, value: input.userId.trim().toLowerCase() } : null,
  ].filter((term) => term !== null);
  if (terms.length !== 1 || (terms[0]!.kind === 'id' && !UUID.test(terms[0]!.value))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Give exactly one of a whole email, a whole handle or an account id [identity.account_search_unset]',
    });
  }
  return terms[0]!;
}

export async function lookupLearnerCard(sql: Sql, context: Context, input: z.infer<typeof identityLearnerCardInputSchema>) {
  const actorId = reader(context);
  const term = learnerCardTerm(input);
  const rows = await sql<
    Array<{
      id: string;
      handle: string;
      email: string;
      status: IdentityLearnerCard['status'];
      created_at: Date;
      total: number;
      recent: number;
      last_at: Date | null;
    }>
  >`
    SELECT u.id, u.handle::text AS handle, u.email::text AS email, u.status, u.created_at,
           (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id) AS total,
           (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.created_at > now() - interval '30 days') AS recent,
           (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_at
      FROM users u
     WHERE (${term.kind} = 'email' AND u.email = ${term.kind === 'email' ? term.value : ''})
        OR (${term.kind} = 'handle' AND lower(u.handle) = lower(${term.kind === 'handle' ? term.value : ''}))
        OR (${term.kind} = 'id' AND u.id = ${term.kind === 'id' ? term.value : '00000000-0000-0000-0000-000000000000'}::uuid)
     LIMIT 1
  `;
  await sql`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actorId}, 'learner_card', ${createHash('sha256').update(`${term.kind}\0${term.value}`).digest('hex')})
  `;
  const row = rows[0];
  if (!row) return { card: null };
  return {
    card: {
      id: row.id,
      handle: row.handle,
      emailMasked: maskEmail(row.email),
      status: row.status,
      created: row.created_at.toISOString(),
      signIns: { total: row.total, last30Days: row.recent, lastAt: row.last_at?.toISOString() ?? null },
    },
  };
}

export function createLearnerCardRouter(sql: Sql) {
  return router({
    learnerCard: router({
      lookup: scopedProcedure('admin:read')
        .input(identityLearnerCardInputSchema)
        .output(identityLearnerCardResultSchema)
        .query(({ ctx, input }) => lookupLearnerCard(sql, ctx, input)),
    }),
  });
}
