import { z } from 'zod';

/**
 * The bridge's wire shapes (D-bridge-chain-03). The bridge is Protocol Plane and non-custodial: it builds unsigned calls
 * the person's wallet signs and posts nothing to the ledger. Which routes exist, and which provider carries them, is an
 * owner decision; until the owner publishes a route table it is blank and `bridge.routes.list` refuses `bridge.routes_unset`.
 */

/** The owner has published no bridge route. The rails room shows its full layout and this blocker, and offers no route. */
export const BRIDGE_ROUTES_UNSET = 'bridge.routes_unset';
/** The route table on file is not a valid list of routes; refused, never read in part. */
export const BRIDGE_ROUTES_INVALID = 'bridge.routes_invalid';

/** A route names a mainnet chain or INTACHAIN: refused at load, since no mainnet leg exists until the audit (audit.external). */
export const BRIDGE_ROUTE_KIND_FORBIDDEN = 'bridge.route_kind_forbidden';

const chainEnd = z
  .object({
    chainId: z.number().int().positive(),
    name: z.string().min(1).max(80),
    /** Only test and local networks may be a route's end. */
    kind: z.enum(['testnet', 'local']),
  })
  .strict();

export const bridgeRouteSchema = z
  .object({
    from: chainEnd,
    to: chainEnd,
    /** The token's symbol on both ends of a burn-and-mint route. */
    token: z.string().min(1).max(16),
    /** The provider the owner chose for this route; null until the owner names one. */
    provider: z.string().min(1).max(80).nullable(),
  })
  .strict();
export type BridgeRoute = z.infer<typeof bridgeRouteSchema>;

export const bridgeRoutesListOutputSchema = z.object({ routes: z.array(bridgeRouteSchema).min(1) }).strict();
export type BridgeRoutesListOutput = z.infer<typeof bridgeRoutesListOutputSchema>;
