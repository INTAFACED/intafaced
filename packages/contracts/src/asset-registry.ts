import { z } from 'zod';
import { customerStepUpPayloadHash } from './customer-step-up.js';

/**
 * ONE SUPPORTED ASSET AND NETWORK REGISTRY (W-balances-05, wallet-balances-025).
 *
 * Deposit, withdraw and trade each kept their own idea of which assets exist, on which networks, and to how many decimal
 * places. `ledger.assets.decimals` was declared and never read. This file is the one wire shape every reader shares:
 * `assets.list` and `assets.get` return these rows, so a deposit screen and a withdraw screen cannot disagree about an
 * asset's precision or its networks.
 *
 * Writes are founder edits under svc-identity's existing action approval (`actionApproval.propose` / `approve`):
 * action type `ledger.asset_edit` (a `ledger.*` action, so founder-only there), target `svc-ledger`, payload the
 * `AssetEditInput` bound by hash. svc-ledger applies it once through `assets.applyEdit { approvalId, operationId, edit }`:
 * identity stores only the payload hash, so svc-ledger recomputes `assetEditPayloadHash(edit)` and identity refuses
 * `payload_mismatch` if the applied edit is not the approved one (the way `matching.open` recomputes from `marketId`).
 * Approval `targetId` = the asset id; `expectedVersion` = the row's current `revision` (`0` for a new asset), so an edit
 * approved against an old row refuses once another edit lands. No second approval mechanism lives here. Nothing here is defaulted. A blank precision refuses with `ledger.asset_precision_unset`; it is
 * never read as 18, or as the precision of some other asset. A retired asset stays listed with its state so history that
 * names it still resolves.
 *
 * Contracts only: zod and pure helpers. `assetEditPayloadHash` uses `node:crypto` (server-side); the rest is browser-safe. The service half (svc-ledger) builds on this in its own PR.
 */

/** Procedure names, so every caller asks the same router. */
export const ASSET_REGISTRY_PROCEDURES = {
  list: 'assets.list',
  get: 'assets.get',
  applyEdit: 'assets.applyEdit',
} as const;

/** Typed refusals. */
export const ASSET_PRECISION_UNSET = 'ledger.asset_precision_unset' as const;
export const ASSET_PRECISION_INVALID = 'ledger.asset_precision_invalid' as const;
export const ASSET_NOT_FOUND = 'ledger.asset_not_found' as const;
export const ASSET_DEFAULT_NETWORK_NOT_LISTED = 'ledger.asset_default_network_not_listed' as const;
export const ASSET_EDIT_INVALID = 'ledger.asset_edit_invalid' as const;
export const ASSET_AMOUNT_INVALID = 'ledger.asset_amount_invalid' as const;
export const ASSET_AMOUNT_EXCEEDS_PRECISION = 'ledger.asset_amount_exceeds_precision' as const;

export type AssetRegistryRefusal =
  | typeof ASSET_PRECISION_UNSET
  | typeof ASSET_PRECISION_INVALID
  | typeof ASSET_NOT_FOUND
  | typeof ASSET_DEFAULT_NETWORK_NOT_LISTED
  | typeof ASSET_EDIT_INVALID
  | typeof ASSET_AMOUNT_INVALID
  | typeof ASSET_AMOUNT_EXCEEDS_PRECISION;

/** Mirrors `ledger.asset_kind`. */
export const REGISTRY_ASSET_KINDS = ['crypto', 'fiat', 'native', 'commodity'] as const;
export const registryAssetKindSchema = z.enum(REGISTRY_ASSET_KINDS);
export type RegistryAssetKind = z.infer<typeof registryAssetKindSchema>;

/** What an asset may be used for. An action not listed is refused by the service that owns it. */
export const ASSET_ACTIONS = ['deposit', 'withdraw', 'trade', 'transfer'] as const;
export const assetActionSchema = z.enum(ASSET_ACTIONS);
export type AssetAction = z.infer<typeof assetActionSchema>;

/** `retired` stays listed; it is never deleted. */
export const ASSET_STATES = ['active', 'halted', 'retired'] as const;
export const assetStateSchema = z.enum(ASSET_STATES);
export type AssetState = z.infer<typeof assetStateSchema>;

/** The ledger stores 18 places; an asset's precision can be at most that. */
export const MAX_ASSET_PRECISION = 18;

export const registryAssetIdSchema = z.string().regex(/^[A-Z0-9]{1,16}$/, 'asset ids are 1-16 upper-case letters or digits');
export const registryNetworkIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'network ids are 1-32 lower-case letters, digits, - or _');

export const assetPrecisionSchema = z.number().int().min(0).max(MAX_ASSET_PRECISION);

export const assetNetworkSchema = z
  .object({
    networkId: registryNetworkIdSchema,
    label: z.string().min(1).max(64),
  })
  .strict();
export type AssetNetwork = z.infer<typeof assetNetworkSchema>;

const assetBodyShape = {
  id: registryAssetIdSchema,
  kind: registryAssetKindSchema,
  precision: assetPrecisionSchema,
  /** Empty for an asset with no chain (fiat, commodity). */
  networks: z.array(assetNetworkSchema).max(64),
  /** Null when the asset has no network, or the owner has not chosen one. Never guessed. */
  defaultNetworkId: registryNetworkIdSchema.nullable(),
  allowedActions: z.array(assetActionSchema).max(ASSET_ACTIONS.length),
  state: assetStateSchema,
};

type AssetBody = {
  networks: AssetNetwork[];
  defaultNetworkId: string | null;
  allowedActions: AssetAction[];
};

function checkBody(body: AssetBody, ctx: z.RefinementCtx): void {
  const ids = body.networks.map((n) => n.networkId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['networks'], message: 'network ids must be unique' });
  }
  if (body.defaultNetworkId !== null && !ids.includes(body.defaultNetworkId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultNetworkId'], message: ASSET_DEFAULT_NETWORK_NOT_LISTED });
  }
  if (new Set(body.allowedActions).size !== body.allowedActions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedActions'], message: 'actions must be unique' });
  }
}

/** One registry row as `assets.list` and `assets.get` return it. */
export const registryAssetSchema = z
  .object({
    ...assetBodyShape,
    /** Bumped by every applied edit; the action approval's `expectedVersion`. `updatedAt` is a clock, not a version. */
    revision: z.number().int().nonnegative().safe(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(checkBody);
export type RegistryAsset = z.infer<typeof registryAssetSchema>;

export const assetsListInputSchema = z
  .object({
    /** Absent lists every state, retired included. */
    state: assetStateSchema.optional(),
    action: assetActionSchema.optional(),
  })
  .strict();
export type AssetsListInput = z.infer<typeof assetsListInputSchema>;

export const assetsListOutputSchema = z.object({ assets: z.array(registryAssetSchema).max(2000) }).strict();
export type AssetsListOutput = z.infer<typeof assetsListOutputSchema>;

export const assetsGetInputSchema = z.object({ assetId: registryAssetIdSchema }).strict();
export type AssetsGetInput = z.infer<typeof assetsGetInputSchema>;

/** A founder edit: the action-approval payload for `ledger.asset_edit`. Creates or replaces one row once applied. */
export const assetEditInputSchema = z
  .object({ ...assetBodyShape, reason: z.string().trim().min(1).max(500) })
  .strict()
  .superRefine(checkBody);
export type AssetEditInput = z.infer<typeof assetEditInputSchema>;

/** The action-approval type for an asset edit. `ledger.*`, so svc-identity makes it founder-only. */
export const ASSET_EDIT_ACTION_TYPE = 'ledger.asset_edit' as const;
/** The service that consumes the approval. */
export const ASSET_EDIT_TARGET_SERVICE = 'svc-ledger' as const;

/**
 * svc-ledger applies an approved edit once, consuming the approval under the caller's operation id. The edit itself
 * travels with the call because identity keeps only its hash.
 */
export const assetApplyEditInputSchema = z
  .object({
    approvalId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
    edit: assetEditInputSchema,
  })
  .strict();
export type AssetApplyEditInput = z.infer<typeof assetApplyEditInputSchema>;

/** JSON with object keys sorted at every depth, so key order never changes the encoding. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The one canonical payload hash for `ledger.asset_edit`, computed the same way by the admin form that proposes and by
 * svc-ledger that consumes. Same construction as `bankActionPayloadHash` (action type plus sorted fields, sha256).
 * Non-string fields are encoded with keys sorted at every depth. `networks` (unique by `networkId`) and
 * `allowedActions` (unique) are sets, so both are sorted first: their order never changes the hash. Uses `node:crypto`
 * like `customerStepUpPayloadHash`, so it is server-side.
 */
export function assetEditPayloadHash(edit: AssetEditInput): string {
  const canonical: Record<string, unknown> = {
    ...edit,
    networks: [...edit.networks].sort((a, b) => (a.networkId < b.networkId ? -1 : a.networkId > b.networkId ? 1 : 0)),
    allowedActions: [...edit.allowedActions].sort(),
  };
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (value === undefined) continue;
    fields[key] = typeof value === 'string' ? value : canonicalJson(value);
  }
  return customerStepUpPayloadHash(ASSET_EDIT_ACTION_TYPE, fields);
}

export type AssetRegistryResult<T> = { ok: true; value: T } | { ok: false; code: AssetRegistryRefusal; message: string };

/**
 * Parse a proposed edit. A missing, null or blank precision is `ledger.asset_precision_unset` (the owner has not said),
 * which is a different refusal from a precision that is present but out of range.
 */
export function parseAssetEdit(input: unknown): AssetRegistryResult<AssetEditInput> {
  if (input !== null && typeof input === 'object') {
    const precision = (input as Record<string, unknown>).precision;
    if (precision === undefined || precision === null || (typeof precision === 'string' && precision.trim() === '')) {
      return { ok: false, code: ASSET_PRECISION_UNSET, message: 'precision is unset; the owner must set it' };
    }
    if (!assetPrecisionSchema.safeParse(precision).success) {
      return {
        ok: false,
        code: ASSET_PRECISION_INVALID,
        message: `precision must be an integer from 0 to ${MAX_ASSET_PRECISION}`,
      };
    }
  }
  const parsed = assetEditInputSchema.safeParse(input);
  if (!parsed.success) {
    const defaultIssue = parsed.error.issues.find((i) => i.message === ASSET_DEFAULT_NETWORK_NOT_LISTED);
    if (defaultIssue) {
      return { ok: false, code: ASSET_DEFAULT_NETWORK_NOT_LISTED, message: 'default network is not one of the networks' };
    }
    return { ok: false, code: ASSET_EDIT_INVALID, message: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

/** Whether an asset may be used for an action right now. Halted and retired assets allow nothing new. */
export function assetAllows(asset: Pick<RegistryAsset, 'state' | 'allowedActions'>, action: AssetAction): boolean {
  return asset.state === 'active' && asset.allowedActions.includes(action);
}

/**
 * A decimal string as scaled bigint at the asset's own precision. More places than the asset has refuses; it is not
 * rounded, because rounding a customer amount is a policy, not a parse.
 */
export function toAssetUnits(amount: string, precision: number): AssetRegistryResult<bigint> {
  if (!assetPrecisionSchema.safeParse(precision).success) {
    return { ok: false, code: ASSET_PRECISION_INVALID, message: 'precision out of range' };
  }
  const match = /^(0|[1-9]\d{0,29})(?:\.(\d{1,18}))?$/.exec(amount);
  if (!match) {
    return { ok: false, code: ASSET_AMOUNT_INVALID, message: 'amount must be a non-negative decimal string' };
  }
  const whole = match[1] as string;
  const fraction = match[2] ?? '';
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) {
    return { ok: false, code: ASSET_AMOUNT_EXCEEDS_PRECISION, message: `more than ${precision} decimal places` };
  }
  const padded = (fraction + '0'.repeat(MAX_ASSET_PRECISION)).slice(0, precision);
  return { ok: true, value: BigInt(whole + padded) };
}
