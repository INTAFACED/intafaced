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
import { isExplicitDevOrTest } from '@intafaced/config';
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

/**
 * An RPC URL is served to every visitor, so one that carries a credential is refused at load: userinfo, a query string, a
 * fragment, or a path segment that looks like an API key (20+ characters of letters, digits, `_` or `-`).
 */
export function rpcUrlCarriesCredential(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.username || url.password || url.search || url.hash) return true;
  return url.pathname.split('/').some((segment) => /^[A-Za-z0-9_-]{20,}$/.test(segment));
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
    if (entry.rpcUrls?.some(rpcUrlCarriesCredential))
      throw new NetworkRegistryError(
        'protocol.network_registry_invalid',
        `chain ${entry.chainId} lists an RPC URL that carries a credential`,
      );
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

/**
 * `PROTOCOL_TEST_NETWORKS_REGISTRY`, read once at boot: the network registry file `networks.list` serves. Blank serves the
 * owner's `deployments/networks.json`. LOCAL TEST only: `TEST:<absolute path>` serves a TEST-labelled registry instead, so a
 * journey can see what a published network adds to a wallet (J-dex-protocol-01 #6, #7); it refuses to boot outside APP_ENV
 * dev or test, and the file is parsed at boot under the same rules as the owner's (no mainnet, no credential in an RPC URL).
 */
export function networksRegistryPathFromSetting(raw: string | undefined, rawAppEnv: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value) return networksRegistryPath;
  const test = /^TEST:(\/.+)$/.exec(value);
  if (!test) throw new Error('PROTOCOL_TEST_NETWORKS_REGISTRY must be TEST:<absolute path>. Refusing to boot.');
  if (!isExplicitDevOrTest(rawAppEnv))
    throw new Error(
      `PROTOCOL_TEST_NETWORKS_REGISTRY is a TEST value but APP_ENV=${rawAppEnv ?? '(unset)'} is not the local test stack. Refusing to boot.`,
    );
  const path = test[1]!.trim();
  loadNetworkRegistry(path);
  return path;
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
