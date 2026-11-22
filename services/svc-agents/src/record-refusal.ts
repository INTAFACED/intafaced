import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/** A machine code sent as the message of a TRPCError thrown with no cause (`agents.capability_unavailable`). */
const AGENTS_CODE = /^agents\.[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * svc-agents' one reader of its own refusals, for `mountRecord`. Its handlers already throw the `TRPCError` they send:
 * a domain refusal (`AgentError` through `toTRPCError` in `router.ts`, `OwnAgentRefusal`, `SessionRunConflict` and the
 * like) carries the refusal it came from as its cause, and the code a record lists is the cause's `code`; a door
 * refused in place sends its machine code as the message, which is then the code. The error leaves exactly as thrown,
 * so mounting a call from its record moves nothing on the wire. Anything else is not a named refusal and goes on
 * unchanged.
 */
export const agentsRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return { code: cause.code, error: err };
  return AGENTS_CODE.test(err.message) ? { code: err.message, error: err } : undefined;
};
