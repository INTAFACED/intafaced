import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExplicitDevOrTest } from '@intafaced/config';
import { z } from 'zod';
import {
  BRIDGE_ROUTE_KIND_FORBIDDEN,
  BRIDGE_ROUTES_INVALID,
  BRIDGE_ROUTES_UNSET,
  bridgeRouteSchema,
  type BridgeRoute,
} from '@intafaced/contracts/protocol-bridge';

/**
 * The owner-published bridge route table (D-bridge-chain-03), `deployments/bridge-routes.json`. Which routes exist and which
 * provider carries them is the owner's decision, so the file ships as an empty list and `bridge.routes.list` refuses
 * `bridge.routes_unset`. A route whose end is a mainnet or INTACHAIN is refused at load: no mainnet leg exists before the
 * external audit, and a label is never unlocked by editing a data file. The bridge is non-custodial and holds no key.
 */
export const bridgeRoutesPath = join(dirname(fileURLToPath(import.meta.url)), '../../deployments/bridge-routes.json');

export class BridgeRoutesError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BridgeRoutesError';
  }
}

export function parseBridgeRoutes(json: unknown): BridgeRoute[] {
  if (!Array.isArray(json)) throw new BridgeRoutesError(BRIDGE_ROUTES_INVALID, 'the route table must be a list');
  for (const row of json) {
    for (const end of ['from', 'to'] as const) {
      const kind = (row as Record<string, { kind?: unknown } | undefined> | null)?.[end]?.kind;
      if (kind === 'mainnet' || kind === 'intachain')
        throw new BridgeRoutesError(BRIDGE_ROUTE_KIND_FORBIDDEN, `a route cannot end on a ${String(kind)} chain`);
    }
  }
  const parsed = z.array(bridgeRouteSchema).safeParse(json);
  if (!parsed.success) throw new BridgeRoutesError(BRIDGE_ROUTES_INVALID, parsed.error.issues[0]?.message ?? 'invalid route');
  const seen = new Set<string>();
  for (const route of parsed.data) {
    if (route.from.chainId === route.to.chainId)
      throw new BridgeRoutesError(BRIDGE_ROUTES_INVALID, `a route from chain ${route.from.chainId} to itself is not a bridge`);
    const key = `${route.from.chainId}:${route.to.chainId}:${route.token}`;
    if (seen.has(key)) throw new BridgeRoutesError(BRIDGE_ROUTES_INVALID, `route ${key} is listed twice`);
    seen.add(key);
  }
  return parsed.data;
}

/** The published routes; an empty table refuses `bridge.routes_unset` rather than answering an empty list. */
export function listBridgeRoutes(load: () => unknown = () => JSON.parse(readFileSync(bridgeRoutesPath, 'utf8'))): BridgeRoute[] {
  const routes = parseBridgeRoutes(load());
  if (routes.length === 0) throw new BridgeRoutesError(BRIDGE_ROUTES_UNSET, 'the owner has published no bridge route');
  return routes;
}

/**
 * The labelled TEST table for the local and test stacks only (OWNER 18, 44): one route between two local TEST chains, its
 * provider marked TEST. It is never the owner's table and is read only when `PROTOCOL_BRIDGE_ROUTES=TEST` on a stack whose
 * raw APP_ENV is exactly `dev` or `test`.
 */
export const TEST_BRIDGE_ROUTES: readonly BridgeRoute[] = Object.freeze([
  {
    from: { chainId: 31337, name: 'TEST local chain', kind: 'local' },
    to: { chainId: 31338, name: 'TEST local chain B', kind: 'local' },
    token: 'TUSDC',
    provider: 'TEST provider',
  },
]);

/**
 * Where the route table comes from. Unset reads the shipped owner file. `TEST` selects the labelled TEST table and refuses
 * to boot unless the raw APP_ENV is `dev` or `test`. Any other value refuses to boot.
 */
export function bridgeRoutesLoader(env: Record<string, string | undefined> = process.env): (() => unknown) | undefined {
  const value = env.PROTOCOL_BRIDGE_ROUTES?.trim() ?? '';
  if (!value) return undefined;
  if (value !== 'TEST') throw new Error(`PROTOCOL_BRIDGE_ROUTES may only be blank or TEST, got "${value}". Refusing to boot.`);
  if (!isExplicitDevOrTest(env.APP_ENV))
    throw new Error(`PROTOCOL_BRIDGE_ROUTES=TEST but APP_ENV=${env.APP_ENV ?? '(unset)'} is not the local test stack. Refusing to boot.`);
  return () => structuredClone(TEST_BRIDGE_ROUTES);
}
