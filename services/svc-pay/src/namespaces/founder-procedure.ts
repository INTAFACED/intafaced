import { middleware, protectedProcedure, TRPCError, type Context } from '@intafaced/contracts';
import { MerchantControlError } from '../merchant-account-controls.js';
import type { FounderAuthority } from '../founder-authority.js';

/**
 * FOUNDER-ONLY PROCEDURES.
 *
 * `founderProcedure(authority)` is the ONLY way to build a procedure under
 * `founderAdmin.*` (and the operator mutations under `payHalts.*`). It runs the
 * existing live founder authority (`createFounderAuthority`): a signed
 * interactive principal with MFA, no API-key id, no sub-account, no
 * service-to-service context, and a current `enabled` founder entitlement read
 * from identity. A refused or unreachable identity refuses; there is no cached allow.
 *
 * It is deliberately NOT `scopedProcedure('admin:read')`: `admin:read` can sit on
 * a long-lived `ifc_` API key, so a scope check would let a leaked key read every
 * merchant's volumes.
 *
 * The authority middleware runs BEFORE input parsing, so an unauthorised caller
 * learns nothing about the input shape.
 */

/** Middleware functions built by `founderProcedure`. A WeakSet cannot be forged by copying a property. */
const FOUNDER_MIDDLEWARES = new WeakSet<object>();

export type FounderContext = Context & { founderUserId: string };

export function founderProcedure(authority: FounderAuthority) {
  const guard = async ({ ctx, next }: { ctx: Context; next: (opts: { ctx: FounderContext }) => Promise<never> }) => {
    let founderUserId: string;
    try {
      founderUserId = await authority(ctx);
    } catch (error) {
      if (error instanceof MerchantControlError) {
        if (error.code === 'authority.unavailable') throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.code, cause: error });
        throw new TRPCError({ code: error.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: error.code, cause: error });
      }
      // Anything unexpected from the authority path is a refusal, never an allow.
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'authority.unavailable', cause: error });
    }
    return next({ ctx: { ...ctx, founderUserId } });
  };
  FOUNDER_MIDDLEWARES.add(guard);
  return protectedProcedure.use(middleware(guard as never));
}

interface ProcedureLike {
  _def: { middlewares?: unknown[] };
}
interface RouterLike {
  _def: { procedures: Record<string, unknown> };
}

/**
 * True when the procedure's middleware chain contains a `founderProcedure` guard
 * AHEAD of every input parser. Order matters: `.input(x).concat(founderProcedure(a))`
 * would contain the guard yet parse (and answer on) the input before it.
 */
export function isFounderGuarded(procedure: unknown): boolean {
  const mws = (procedure as ProcedureLike)._def?.middlewares;
  if (!Array.isArray(mws)) return false;
  const guardAt = mws.findIndex((m) => typeof m === 'function' && FOUNDER_MIDDLEWARES.has(m));
  if (guardAt < 0) return false;
  const firstInput = mws.findIndex((m) => (m as { _type?: unknown } | null)?._type === 'input');
  return firstInput < 0 || guardAt < firstInput;
}

/**
 * Static route inventory (isolation suite G7). Returns the dotted path of every
 * procedure whose path starts with one of `prefixes` and is NOT behind founder
 * authority. An empty array is the only passing answer. It reads the router's
 * procedure table, so a procedure cannot be added to the namespace and missed.
 */
export function findUnguardedFounderProcedures(routerValue: unknown, prefixes: readonly string[]): string[] {
  const procedures = (routerValue as RouterLike)._def.procedures;
  return Object.keys(procedures)
    .filter((path) => prefixes.some((p) => path.startsWith(p)))
    .filter((path) => !isFounderGuarded(procedures[path]))
    .sort();
}
