import { z } from 'zod';
import { payAssetCodeSchema } from '@intafaced/contracts';
import { looksLikeSecret } from '../registries/secret-guard.js';

/**
 * Wire shapes for `founderAdmin.custody.*`. Every input object is `.strict()`; an unknown field is a parse error.
 * Nothing here is a balance: the ledger is the only book. A blank entity, environment, name or reference is a
 * parse error, never a default.
 */
export const CUSTODY_ENVIRONMENTS = ['sandbox', 'testnet', 'mainnet'] as const;
export const environmentSchema = z.enum(CUSTODY_ENVIRONMENTS);
export const CUSTODY_OWNERSHIPS = ['entity_owned', 'customer_attributed'] as const;
export const ownershipSchema = z.enum(CUSTODY_OWNERSHIPS);

const entityId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'an entity id is lowercase words joined by hyphens');
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !looksLikeSecret(v), 'custody.secret_like_value: credentials are never stored as a name');
const clientRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, "a client reference is the caller's own business key");
const customerRef = z.string().trim().min(1).max(128);
const vaultId = z.string().uuid();
const walletId = z.string().uuid();
const networkId = z.string().min(1).max(64);
const address = z.string().trim().min(1).max(256);
/** A list has no default page size: the caller says how many. */
const limit = z.number().int().min(1).max(200);

export const entityCreateInputSchema = z
  .object({
    entityId,
    displayName: name,
    ownership: ownershipSchema,
    environment: environmentSchema,
    /** Required for `customer_attributed`, refused for `entity_owned`. */
    customerRef: customerRef.optional(),
  })
  .strict();
export type EntityCreateInput = z.infer<typeof entityCreateInputSchema>;

export const entityListInputSchema = z.object({ limit, after: entityId.optional(), environment: environmentSchema.optional() }).strict();
export type EntityListInput = z.infer<typeof entityListInputSchema>;

export const accountKeyInputSchema = z.object({ entityId }).strict();

export const entityViewSchema = z
  .object({
    entityId,
    displayName: z.string(),
    ownership: ownershipSchema,
    environment: environmentSchema,
    /** True for every environment but `mainnet`, so a console always shows the badge. */
    testBadge: z.boolean(),
    customerRef: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .strict();
export type EntityView = z.infer<typeof entityViewSchema>;

/** The ownership read over an entity. Counts only: no balance is held or shown here. */
export const accountViewSchema = entityViewSchema
  .extend({ vaults: z.number().int(), hiddenVaults: z.number().int(), wallets: z.number().int() })
  .strict();
export type AccountView = z.infer<typeof accountViewSchema>;

export const walletTypeViewSchema = z
  .object({ networkId, displayName: z.string(), enabled: z.boolean(), assetCodes: z.array(payAssetCodeSchema) })
  .strict();
export type WalletTypeView = z.infer<typeof walletTypeViewSchema>;

export const vaultCreateInputSchema = z.object({ entityId, clientRef, name }).strict();
export type VaultCreateInput = z.infer<typeof vaultCreateInputSchema>;
export const vaultRenameInputSchema = z.object({ vaultId, name, expectedVersion: z.number().int().min(1).max(2_147_483_647) }).strict();
export const vaultVisibilityInputSchema = z
  .object({ vaultId, hidden: z.boolean(), expectedVersion: z.number().int().min(1).max(2_147_483_647) })
  .strict();
export const VAULT_VISIBILITIES = ['visible', 'hidden', 'all'] as const;
export const vaultListInputSchema = z
  .object({ entityId, visibility: z.enum(VAULT_VISIBILITIES), limit, after: vaultId.optional() })
  .strict();
/** The reconciliation read: every vault of every entity, hidden or not. There is no visibility filter to pass. */
export const vaultReconciliationInputSchema = z.object({ limit, after: vaultId.optional() }).strict();

export const vaultViewSchema = z
  .object({
    vaultId,
    entityId,
    clientRef: z.string(),
    name: z.string(),
    hidden: z.boolean(),
    version: z.number().int(),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();
export type VaultView = z.infer<typeof vaultViewSchema>;

export const walletAddInputSchema = z.object({ vaultId, networkId, assetCode: payAssetCodeSchema }).strict();
export const walletListInputSchema = z.object({ vaultId, limit, after: walletId.optional() }).strict();
export const walletGetInputSchema = z.object({ walletId }).strict();
export const walletLookupInputSchema = z.object({ networkId, address }).strict();

export const walletViewSchema = z
  .object({
    walletId,
    vaultId,
    entityId,
    networkId,
    assetCode: z.string(),
    /** `null` until address assignment (W-custody-ops-03) fills it in. */
    address: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .strict();
export type WalletView = z.infer<typeof walletViewSchema>;

/** Who owns an address: the wallet, its vault and its entity. */
export const ownerLookupSchema = z.object({ wallet: walletViewSchema, vault: vaultViewSchema, entity: entityViewSchema }).strict();
export type OwnerLookup = z.infer<typeof ownerLookupSchema>;
