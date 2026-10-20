import { z } from 'zod';

/**
 * Wire types for the Protocol networks, deployments and capabilities reads (D-bridge-chain-05).
 *
 * Browser-safe: zod only, so the customer app can import it through `@intafaced/contracts/protocol-networks`.
 *
 * Every published field is nullable and null means "the owner has not published this", never a guess. A network's `kind` can be
 * `testnet`, `local` or `unconfirmed` and nothing else: `mainnet` and `intachain` are not values this wire can carry, and the
 * service refuses to load a registry that names them (`protocol.network_kind_forbidden`).
 */

export const NETWORK_KINDS = ['testnet', 'local', 'unconfirmed'] as const;
export const networkKindSchema = z.enum(NETWORK_KINDS);
export type NetworkKind = z.infer<typeof networkKindSchema>;

/** Kinds an owner edit must never be able to set from a registry file. */
export const FORBIDDEN_NETWORK_KINDS = ['mainnet', 'intachain'] as const;
export const NETWORK_KIND_FORBIDDEN = 'protocol.network_kind_forbidden' as const;
export const NETWORK_PARAMS_UNSET = 'protocol.network_params_unset' as const;

const httpsUrl = z
  .string()
  .url()
  .refine((url) => url.startsWith('https://'), 'must be https://');
const rpcUrl = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//.test(url), 'must be http(s)://');

export const networkEntrySchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1).nullable(),
  kind: networkKindSchema,
  nativeCurrency: z.object({ name: z.string().min(1), symbol: z.string().min(1), decimals: z.number().int().min(0).max(36) }).nullable(),
  rpcUrls: z.array(rpcUrl).min(1).nullable(),
  blockTimeSeconds: z.number().positive().nullable(),
  explorerUrls: z.array(httpsUrl).min(1).nullable(),
  /** Third-party faucets only: this platform holds no key to drip from. */
  faucets: z.array(z.object({ name: z.string().min(1), url: httpsUrl })).nullable(),
  ecosystem: z.array(z.object({ name: z.string().min(1), url: httpsUrl, kind: z.string().min(1) })).nullable(),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;

export const protocolNetworksListOutputSchema = z.object({ networks: z.array(networkEntrySchema) }).strict();
export type ProtocolNetworksListOutput = z.infer<typeof protocolNetworksListOutputSchema>;

/** Whether "Add to wallet" may be offered: only when the name, the RPC URL and the native currency are all published (`wallet_addEthereumChain` needs each). */
export function canAddToWallet(network: Pick<NetworkEntry, 'name' | 'rpcUrls' | 'nativeCurrency'>): boolean {
  return network.name !== null && network.rpcUrls !== null && network.nativeCurrency !== null;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const deploymentContractSchema = z.object({
  name: z.string().min(1),
  suite: z.string().min(1),
  address,
  verified: z.boolean(),
  explorerUrl: httpsUrl.nullable(),
});
export const routerVersionSchema = z.object({
  name: z.string().min(1),
  address,
  version: z.string().min(1),
  deployedAt: z.string().nullable(),
  verified: z.boolean(),
  /** Owner-set. Null = no sunset published. */
  sunsetAt: z.string().datetime().nullable(),
});
export const protocolDeploymentsInputSchema = z.object({ chainId: z.number().int().positive() }).strict();
export const protocolDeploymentsOutputSchema = z
  .object({
    chainId: z.number().int().positive(),
    chainName: z.string().min(1),
    deployedAt: z.string().nullable(),
    contracts: z.array(deploymentContractSchema),
    routers: z.array(routerVersionSchema),
  })
  .strict();
export type ProtocolDeploymentsOutput = z.infer<typeof protocolDeploymentsOutputSchema>;

/** A router version is past its sunset when the owner published a date and `now` is on or after it. */
export function routerIsSunset(router: Pick<z.infer<typeof routerVersionSchema>, 'sunsetAt'>, now: Date): boolean {
  return router.sunsetAt !== null && now.getTime() >= Date.parse(router.sunsetAt);
}

export const protocolCapabilitiesInputSchema = z.object({ chainId: z.number().int().positive() }).strict();
/** Booleans measured by probing the node; null = this probe could not be made, never a guess. */
export const protocolCapabilitiesOutputSchema = z
  .object({
    chainId: z.number().int().positive(),
    probed: z.boolean(),
    pendingTag: z.boolean().nullable(),
    bundlerReachable: z.boolean().nullable(),
    paymasterFunded: z.boolean().nullable(),
    /** Always "not offered" or "unknown": a preconfirmation feed is not something this probe can find on a plain node. */
    preconfirmations: z.enum(['not_offered', 'unknown']),
  })
  .strict();
export type ProtocolCapabilitiesOutput = z.infer<typeof protocolCapabilitiesOutputSchema>;
