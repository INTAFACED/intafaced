import { z } from 'zod';
import { router, scopedProcedure, TRPCError, type Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { roleHasPermission, type MerchantRole } from '../merchant-ops/roles.js';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure } from '../namespaces/founder-procedure.js';
import { postgresB2bRampAccess, type B2bRampAccess } from './access.js';
import { B2B_RAMP_DEFERRED, loadB2bRampConfig, type B2bRampConfig, type B2bRampEnv } from './config.js';
import { B2bRampBootError, B2bRampError } from './errors.js';
import { BankStatementReconciliation, type B2bCreditInput, type B2bCreditResult } from './socket.js';

/**
 * `b2bRamp.*` — direct svc-pay procedures for the switched-off ramp.
 *
 * While `pay.b2b_ramp` is off, every procedure refuses, including a caller
 * who reached this process without the edge. Founder status is founder-only.
 * Merchant reads require the caller to own the merchant or be an active
 * team member. A founder who is not on that team learns nothing from the
 * merchant procedures; the founder procedure returns no merchant rows.
 *
 * Credit ignores `clientSettledAmount`. The socket never receives it.
 * Admitting the credit still does not post a ledger entry.
 */

const stateSchema = z.object({
  flag: z.literal('pay.b2b_ramp'),
  enabled: z.literal(true),
  licenceAttestation: z.enum(['present', 'absent']),
  reconciliationSocket: z.literal('wired'),
  deferred: z.tuple([z.literal('intake'), z.literal('batches'), z.literal('executions'), z.literal('events')]),
});

const merchantStatusSchema = stateSchema.extend({ merchantId: z.string().guid() });

const creditSchema = z.object({
  creditId: z.string().guid(),
  merchantId: z.string().guid(),
  bankLineId: z.string(),
  amount: z.string(),
  asset: z.string(),
  reconciled: z.literal(true),
  ledgerPosted: z.literal(false),
});

const creditInputSchema = z.object({
  merchantId: z.string().guid(),
  bankLineId: z.string().min(1),
  amount: z.string(),
  asset: z.string(),
  /** Accepted so a client claim is not a schema error. It is not used. */
  clientSettledAmount: z.string().optional(),
});

export interface B2bRampCreditPort {
  credit(input: B2bCreditInput): Promise<B2bCreditResult>;
  get(creditId: string): Promise<B2bCreditResult | null>;
}

export interface B2bRampRouterDeps {
  founderAuthority: FounderAuthority;
  sql?: Sql;
  env?: B2bRampEnv;
  access?: B2bRampAccess;
  port?: B2bRampCreditPort;
}

function asTrpc(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof B2bRampError) {
    const code =
      error.kind === 'unavailable'
        ? 'SERVICE_UNAVAILABLE'
        : error.kind === 'not_found'
          ? 'NOT_FOUND'
          : error.kind === 'bad_request'
            ? 'BAD_REQUEST'
            : 'FORBIDDEN';
    throw new TRPCError({ code, message: error.code, cause: error });
  }
  if (error instanceof B2bRampBootError) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.code, cause: error });
  }
  const cause = new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: cause.code, cause });
}

function stateOf(config: B2bRampConfig) {
  return {
    flag: config.flag,
    enabled: true as const,
    licenceAttestation: config.licenceAttestation,
    reconciliationSocket: 'wired' as const,
    deferred: [...B2B_RAMP_DEFERRED] as ['intake', 'batches', 'executions', 'events'],
  };
}

export function createB2bRampRouter(deps: B2bRampRouterDeps) {
  const env = deps.env ?? process.env;
  const port = deps.port ?? (deps.sql ? new BankStatementReconciliation(deps.sql, env) : undefined);
  const access = deps.access ?? (deps.sql ? postgresB2bRampAccess(deps.sql) : undefined);
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const founder = founderProcedure(deps.founderAuthority);

  const requireOn = (): B2bRampConfig => {
    const config = loadB2bRampConfig(env);
    if (config.mode !== 'on') throw new B2bRampError('pay.b2b_ramp_off', 'refused');
    return config;
  };

  const requireRole = async (ctx: Context, merchantId: string): Promise<MerchantRole> => {
    if (!access) throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
    const userId = ctx.principal?.userId;
    if (!userId) throw new B2bRampError('pay.merchant_not_found', 'not_found');
    const role = await access.roleFor(userId, merchantId);
    if (!role) throw new B2bRampError('pay.merchant_not_found', 'not_found');
    return role;
  };

  return router({
    b2bRamp: router({
      status: read
        .input(z.object({ merchantId: z.string().guid() }))
        .output(merchantStatusSchema)
        .query(async ({ ctx, input }) => {
          try {
            const config = requireOn();
            await requireRole(ctx, input.merchantId);
            return { ...stateOf(config), merchantId: input.merchantId };
          } catch (error) {
            asTrpc(error);
          }
        }),
      credit: write
        .input(creditInputSchema)
        .output(creditSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            requireOn();
            const role = await requireRole(ctx, input.merchantId);
            if (!roleHasPermission(role, 'payout.request')) throw new B2bRampError('pay.team_role_forbidden', 'refused');
            if (!port) throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
            return await port.credit({
              merchantId: input.merchantId,
              bankLineId: input.bankLineId,
              amount: input.amount,
              asset: input.asset,
            });
          } catch (error) {
            asTrpc(error);
          }
        }),
      get: read
        .input(z.object({ creditId: z.string().guid() }))
        .output(creditSchema)
        .query(async ({ ctx, input }) => {
          try {
            requireOn();
            if (!port || !access) throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
            const row = await port.get(input.creditId);
            if (!row) throw new B2bRampError('pay.b2b_ramp_not_found', 'not_found');
            const role = await access.roleFor(ctx.principal?.userId ?? '', row.merchantId);
            if (!role) throw new B2bRampError('pay.b2b_ramp_not_found', 'not_found');
            return row;
          } catch (error) {
            asTrpc(error);
          }
        }),
      founderStatus: founder.output(stateSchema).query(async () => {
        try {
          return stateOf(requireOn());
        } catch (error) {
          asTrpc(error);
        }
      }),
    }),
  });
}
