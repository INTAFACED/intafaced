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

// ── transfers (D-bridge-chain-03, J-dex-protocol-05 #6 #7) ────────────────────────────────────────────────────────────

/**
 * No bridge provider is connected: the owner has chosen none, so a route can be listed but no transfer is built. Only the
 * labelled TEST provider on the local and test stacks carries a transfer today.
 */
export const BRIDGE_PROVIDER_UNSET = 'bridge.provider_unset';
/** The transfer names a route the table does not list. */
export const BRIDGE_ROUTE_UNKNOWN = 'bridge.route_unknown';
/** The amount is not a positive decimal with at most the token's places. */
export const BRIDGE_AMOUNT_INVALID = 'bridge.amount_invalid';
/** No transfer with this id belongs to this wallet. */
export const BRIDGE_TRANSFER_NOT_FOUND = 'bridge.transfer_not_found';
/** The transaction handed in is not this transfer's burn (another call, another wallet, or another intent). */
export const BRIDGE_BURN_MISMATCH = 'bridge.burn_mismatch';
/** The same key was used before for a transfer with other terms. */
export const BRIDGE_KEY_CONFLICT = 'bridge.key_conflict';
/** This wallet already has as many transfers waiting for their burn as the service keeps. */
export const BRIDGE_TOO_MANY_WAITING = 'bridge.too_many_waiting';
/** A route's chain or the provider's attestation service could not be read; nothing was changed. */
export const BRIDGE_UNREACHABLE = 'bridge.unreachable';

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** An unsigned call the person's wallet sends on `chainId`; the service never signs or sends it. */
export const bridgeCallSchema = z
  .object({ chainId: z.number().int().positive(), to: evmAddress, data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) })
  .strict();
export type BridgeCall = z.infer<typeof bridgeCallSchema>;

/**
 * Where a transfer is: its intent is stored and the burn is waiting for the wallet; the burn is on the source chain; the
 * provider attested it and the mint can be signed on the destination chain; the mint is on the destination chain.
 */
export const bridgeTransferStateSchema = z.enum(['awaiting_burn', 'burn_submitted', 'mint_ready', 'minted']);
export type BridgeTransferState = z.infer<typeof bridgeTransferStateSchema>;

export const bridgeTransferSchema = z
  .object({
    id: z.string().uuid(),
    /** The intent id the burn and the mint carry on chain: each burns once and mints once. */
    intentId: txHash,
    wallet: evmAddress,
    from: z.object({ chainId: z.number().int().positive(), name: z.string() }).strict(),
    to: z.object({ chainId: z.number().int().positive(), name: z.string() }).strict(),
    token: z.string(),
    /** Decimal string in the token's units. */
    amount: z.string(),
    provider: z.string().nullable(),
    state: bridgeTransferStateSchema,
    burnTx: txHash.nullable(),
    /** The burn to sign, while the transfer waits for it; null once a burn for its intent is on chain. */
    burnCall: bridgeCallSchema.nullable(),
    /** The mint to sign, once the provider has attested the burn; null before, and once minted. */
    mintCall: bridgeCallSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();
export type BridgeTransfer = z.infer<typeof bridgeTransferSchema>;

export const bridgeTransferStartInputSchema = z
  .object({
    wallet: evmAddress,
    fromChainId: z.number().int().positive(),
    toChainId: z.number().int().positive(),
    /** The route's token symbol. */
    asset: z.string().min(1).max(16),
    amount: z.string().min(1).max(40),
    /** The client's business key for this one transfer: the same key answers the same transfer, never a second one. */
    clientKey: z.string().regex(/^[A-Za-z0-9:_-]{8,80}$/),
  })
  .strict();
export const bridgeTransferBurnInputSchema = z.object({ wallet: evmAddress, id: z.string().uuid(), txHash }).strict();
export const bridgeTransfersListInputSchema = z.object({ wallet: evmAddress }).strict();
export const bridgeTransfersListOutputSchema = z.object({ transfers: z.array(bridgeTransferSchema) }).strict();
