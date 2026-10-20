import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  FORBIDDEN_NETWORK_KINDS,
  NETWORK_KIND_FORBIDDEN,
  networkEntrySchema,
  routerIsSunset,
  type NetworkEntry,
  type ProtocolDeploymentsOutput,
} from '@intafaced/contracts';
import { parseDeploymentRegistry } from '../deployments/registry.js';

/**
 * The owner-published network registry and router versions, served by `networks.list` and `deployments.list`.
 *
 * The files are `deployments/networks.json` and `deployments/router-versions.json`. A network can be `testnet`, `local` or
 * `unconfirmed`. A registry file that names `mainnet` or `intachain` is refused at load (`protocol.network_kind_forbidden`):
 * a label is never unlocked by editing a line in a data file. Every field the owner has not published stays null.
 */
const deploymentsDir = join(dirname(fileURLToPath(import.meta.url)), '../../deployments');
export const networksRegistryPath = join(deploymentsDir, 'networks.json');
export const routerVersionsPath = join(deploymentsDir, 'router-versions.json');
export const baseSepoliaDeploymentPath = join(deploymentsDir, 'base-sepolia.json');

export class NetworkRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'NetworkRegistryError';
  }
}

export function parseNetworkRegistry(json: unknown): NetworkEntry[] {
  if (!Array.isArray(json)) throw new NetworkRegistryError('protocol.network_registry_invalid', 'the registry must be a list');
  for (const row of json) {
    const kind = (row as { kind?: unknown } | null)?.kind;
    if ((FORBIDDEN_NETWORK_KINDS as readonly unknown[]).includes(kind)) {
      throw new NetworkRegistryError(NETWORK_KIND_FORBIDDEN, `a registry entry cannot carry kind "${String(kind)}".`);
    }
  }
  const parsed = z.array(networkEntrySchema).safeParse(json);
  if (!parsed.success)
    throw new NetworkRegistryError('protocol.network_registry_invalid', parsed.error.issues[0]?.message ?? 'invalid entry');
  const seen = new Set<number>();
  for (const entry of parsed.data) {
    if (seen.has(entry.chainId))
      throw new NetworkRegistryError('protocol.network_registry_invalid', `chain ${entry.chainId} is listed twice`);
    seen.add(entry.chainId);
  }
  return parsed.data;
}

const routerVersionFileSchema = z.array(
  z.object({
    chainId: z.number().int().positive(),
    name: z.string().min(1),
    version: z.string().min(1),
    sunsetAt: z.string().datetime().nullable(),
  }),
);
export type RouterVersionRow = z.infer<typeof routerVersionFileSchema>[number];

export function parseRouterVersions(json: unknown): RouterVersionRow[] {
  return routerVersionFileSchema.parse(json);
}

export const loadNetworkRegistry = (path = networksRegistryPath): NetworkEntry[] =>
  parseNetworkRegistry(JSON.parse(readFileSync(path, 'utf8')));
export const loadRouterVersions = (path = routerVersionsPath): RouterVersionRow[] =>
  parseRouterVersions(JSON.parse(readFileSync(path, 'utf8')));

/** The deployed-contract registry for a chain, in the wire shape. Null when no deployment is recorded for that chain. */
export function deploymentsFor(
  chainId: number,
  sources: { deployments?: unknown; routers?: RouterVersionRow[] } = {},
): ProtocolDeploymentsOutput | null {
  if (chainId !== 84532) return null;
  const registry = parseDeploymentRegistry(sources.deployments ?? JSON.parse(readFileSync(baseSepoliaDeploymentPath, 'utf8')));
  if (registry.chainId !== chainId) return null;
  const versions = (sources.routers ?? loadRouterVersions()).filter((row) => row.chainId === chainId);
  const routers = registry.contracts.flatMap((contract) => {
    const version = versions.find((row) => row.name === contract.name);
    return version
      ? [
          {
            name: contract.name,
            address: contract.address,
            version: version.version,
            deployedAt: registry.deployedAt ?? null,
            verified: contract.verified,
            sunsetAt: version.sunsetAt,
          },
        ]
      : [];
  });
  return {
    chainId,
    chainName: registry.chainName,
    deployedAt: registry.deployedAt ?? null,
    contracts: registry.contracts.map((contract) => ({
      name: contract.name,
      suite: contract.suite,
      address: contract.address,
      verified: contract.verified,
      explorerUrl: contract.explorerUrl ?? null,
    })),
    routers,
  };
}

/** True when the owner has published a sunset date for this router version and it has passed. */
export function routerVersionIsSunset(
  chainId: number,
  name: string,
  now: Date,
  routers: RouterVersionRow[] = loadRouterVersions(),
): boolean {
  const row = routers.find((r) => r.chainId === chainId && r.name === name);
  return row !== undefined && routerIsSunset(row, now);
}
