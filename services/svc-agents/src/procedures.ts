import { scopedProcedure, TRPCError } from '@intafaced/contracts';

/**
 * Running an agent spends the person's money, so only the person runs one (OWNER 107): their own signed-in session,
 * never an API key (`agents:execute` is interactive-only in packages/auth), a sub-account or delegated token, or a
 * service forwarding their principal.
 */
export function executeProcedure() {
  return scopedProcedure('agents:execute', { module: 'agents', person: true }).use(({ ctx, next }) => {
    if (ctx.principal.kid || ctx.principal.sub_account) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.execute_person_only' });
    }
    return next();
  });
}
