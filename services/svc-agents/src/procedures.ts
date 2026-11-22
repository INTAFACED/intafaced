import { scopedProcedure } from '@intafaced/contracts/trpc';

/**
 * Running an agent spends the person's money, so only the person runs one (OWNER 107): their own signed-in session,
 * never an API key (`agents:execute` is interactive-only in packages/auth), a sub-account or delegated token, or a
 * service forwarding their principal.
 */
export function executeProcedure() {
  return scopedProcedure('agents:execute', { module: 'agents', person: true, ownSession: 'agents.execute_person_only' });
}
