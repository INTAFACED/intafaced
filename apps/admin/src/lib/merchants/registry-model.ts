import { compareDecimal, isDecimalString } from './money';

/**
 * Venue, network and wallet-route registries (svc-pay `founderAdmin.registries.*`).
 *
 * The wire schemas live in svc-pay and are not published in `@intafaced/contracts`
 * yet, so the shapes and the field rules are mirrored here by hand. The server
 * still validates everything again; these rules only give the founder an answer
 * before the round trip, in plain English. Hoisting the schemas into contracts
 * would remove the copy (recorded as a gap).
 */

export type RegistryKind = 'venue' | 'network' | 'wallet_route';
export const REGISTRY_KINDS: readonly RegistryKind[] = ['venue', 'network', 'wallet_route'];

export interface RegistryInfo {
  readonly kind: RegistryKind;
  readonly slug: 'venues' | 'networks' | 'wallet-routes';
  readonly title: string;
  readonly singular: string;
  readonly purpose: string;
  /** tRPC list procedure under `founderAdmin.registries.`. */
  readonly listProcedure: 'venues.list' | 'networks.list' | 'walletRoutes.list';
}

export const REGISTRY_INFO: Record<RegistryKind, RegistryInfo> = {
  venue: {
    kind: 'venue',
    slug: 'venues',
    title: 'Venues',
    singular: 'venue',
    purpose: 'The exchanges and liquidity venues a conversion can be routed to, with their order limits and priority.',
    listProcedure: 'venues.list',
  },
  network: {
    kind: 'network',
    slug: 'networks',
    title: 'Networks',
    singular: 'network',
    purpose: 'The settlement networks the platform can pay out on, with the assets, confirmations and fee estimate for each.',
    listProcedure: 'networks.list',
  },
  wallet_route: {
    kind: 'wallet_route',
    slug: 'wallet-routes',
    title: 'Wallet routes',
    singular: 'wallet route',
    purpose: 'Which asset may be paid out on which network, who may use the route and the largest single payout.',
    listProcedure: 'walletRoutes.list',
  },
};

export function kindFromSlug(slug: string): RegistryKind | null {
  return REGISTRY_KINDS.find((kind) => REGISTRY_INFO[kind].slug === slug) ?? null;
}

// ── views (what the service returns) ───────────────────────────────────────
interface Stamp {
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly routable: boolean;
  readonly missing: readonly string[];
}
export interface VenueView extends Stamp {
  readonly venueId: string;
  readonly displayName: string;
  readonly mode: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly minOrder: string | null;
  readonly maxOrder: string | null;
  readonly supportedPairs: readonly string[];
  readonly health: { healthy: boolean; latencyMs: number; lastUpdate: string; reason?: string } | null;
}
export interface NetworkView extends Stamp {
  readonly networkId: string;
  readonly displayName: string;
  readonly assetCodes: readonly string[];
  readonly confirmationsRequired: number | null;
  readonly enabled: boolean;
  readonly feeEstimateSource: string | null;
  readonly feeEstimateAmount: string | null;
}
export interface WalletRouteView extends Stamp {
  readonly routeId: string;
  readonly assetCode: string;
  readonly networkId: string;
  readonly payoutAllowed: boolean;
  readonly merchantAllow: readonly string[];
  readonly merchantDeny: readonly string[];
  readonly maxSinglePayout: string | null;
}
export type RegistryView = VenueView | NetworkView | WalletRouteView;

export interface RegistryEventView {
  readonly id: string;
  readonly seq: string;
  readonly registry: RegistryKind;
  readonly entryKey: string;
  readonly action: 'create' | 'update';
  readonly actorId: string;
  readonly approverId: string | null;
  readonly dualControl: boolean;
  readonly reason: string;
  readonly createdAt: string;
}

export interface RegistryPreview {
  readonly needsDualControl: boolean;
  readonly reasons: readonly string[];
  readonly actionType: string;
  readonly payloadHash: string;
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const nullable = (v: unknown, test: (x: unknown) => boolean): boolean => v === null || test(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const stamped = (v: Record<string, unknown>): boolean =>
  int(v.version) && str(v.updatedAt) && str(v.updatedBy) && typeof v.routable === 'boolean' && strList(v.missing);

export function asVenue(raw: unknown): VenueView | null {
  if (!rec(raw) || !stamped(raw)) return null;
  const ok =
    str(raw.venueId) &&
    str(raw.displayName) &&
    str(raw.mode) &&
    int(raw.priority) &&
    typeof raw.enabled === 'boolean' &&
    nullable(raw.minOrder, str) &&
    nullable(raw.maxOrder, str) &&
    strList(raw.supportedPairs) &&
    nullable(raw.health, rec);
  return ok ? (raw as unknown as VenueView) : null;
}
export function asNetwork(raw: unknown): NetworkView | null {
  if (!rec(raw) || !stamped(raw)) return null;
  const ok =
    str(raw.networkId) &&
    str(raw.displayName) &&
    strList(raw.assetCodes) &&
    nullable(raw.confirmationsRequired, int) &&
    typeof raw.enabled === 'boolean' &&
    nullable(raw.feeEstimateSource, str) &&
    nullable(raw.feeEstimateAmount, str);
  return ok ? (raw as unknown as NetworkView) : null;
}
export function asWalletRoute(raw: unknown): WalletRouteView | null {
  if (!rec(raw) || !stamped(raw)) return null;
  const ok =
    str(raw.routeId) &&
    str(raw.assetCode) &&
    str(raw.networkId) &&
    typeof raw.payoutAllowed === 'boolean' &&
    strList(raw.merchantAllow) &&
    strList(raw.merchantDeny) &&
    nullable(raw.maxSinglePayout, str);
  return ok ? (raw as unknown as WalletRouteView) : null;
}
export function asEvent(raw: unknown): RegistryEventView | null {
  if (!rec(raw)) return null;
  const ok =
    str(raw.id) &&
    str(raw.seq) &&
    str(raw.registry) &&
    str(raw.entryKey) &&
    (raw.action === 'create' || raw.action === 'update') &&
    str(raw.actorId) &&
    nullable(raw.approverId, str) &&
    typeof raw.dualControl === 'boolean' &&
    str(raw.reason) &&
    str(raw.createdAt);
  return ok ? (raw as unknown as RegistryEventView) : null;
}
export function asPreview(raw: unknown): RegistryPreview | null {
  if (!rec(raw)) return null;
  return typeof raw.needsDualControl === 'boolean' && strList(raw.reasons) && str(raw.actionType) && str(raw.payloadHash)
    ? (raw as unknown as RegistryPreview)
    : null;
}
export function asList<T>(raw: unknown, each: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = each(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

export function viewKey(kind: RegistryKind, view: RegistryView): string {
  if (kind === 'venue') return (view as VenueView).venueId;
  if (kind === 'network') return (view as NetworkView).networkId;
  return (view as WalletRouteView).routeId;
}

// ── forms ───────────────────────────────────────────────────────────────────
/** Text values exactly as typed. Converted and validated by `buildChange`. */
export interface RegistryFormValues {
  // venue
  venueId: string;
  displayName: string;
  mode: string;
  priority: string;
  enabled: boolean;
  minOrder: string;
  maxOrder: string;
  supportedPairs: string;
  // network
  networkId: string;
  assetCodes: string;
  confirmationsRequired: string;
  feeEstimateSource: string;
  feeEstimateAmount: string;
  // wallet route
  assetCode: string;
  payoutAllowed: boolean;
  merchantAllow: string;
  merchantDeny: string;
  maxSinglePayout: string;
  // common
  reason: string;
}

export const EMPTY_FORM: RegistryFormValues = {
  venueId: '',
  displayName: '',
  mode: 'disabled',
  priority: '100',
  enabled: false,
  minOrder: '',
  maxOrder: '',
  supportedPairs: '',
  networkId: '',
  assetCodes: '',
  confirmationsRequired: '',
  feeEstimateSource: '',
  feeEstimateAmount: '',
  assetCode: '',
  payoutAllowed: false,
  merchantAllow: '',
  merchantDeny: '',
  maxSinglePayout: '',
  reason: '',
};

export function formFromView(kind: RegistryKind, view: RegistryView): RegistryFormValues {
  const base = { ...EMPTY_FORM };
  if (kind === 'venue') {
    const v = view as VenueView;
    return {
      ...base,
      venueId: v.venueId,
      displayName: v.displayName,
      mode: v.mode,
      priority: String(v.priority),
      enabled: v.enabled,
      minOrder: v.minOrder ?? '',
      maxOrder: v.maxOrder ?? '',
      supportedPairs: v.supportedPairs.join(', '),
    };
  }
  if (kind === 'network') {
    const n = view as NetworkView;
    return {
      ...base,
      networkId: n.networkId,
      displayName: n.displayName,
      assetCodes: n.assetCodes.join(', '),
      confirmationsRequired: n.confirmationsRequired === null ? '' : String(n.confirmationsRequired),
      enabled: n.enabled,
      feeEstimateSource: n.feeEstimateSource ?? '',
      feeEstimateAmount: n.feeEstimateAmount ?? '',
    };
  }
  const w = view as WalletRouteView;
  return {
    ...base,
    assetCode: w.assetCode,
    networkId: w.networkId,
    payoutAllowed: w.payoutAllowed,
    merchantAllow: w.merchantAllow.join(', '),
    merchantDeny: w.merchantDeny.join(', '),
    maxSinglePayout: w.maxSinglePayout ?? '',
  };
}

export type FieldErrors = Partial<Record<keyof RegistryFormValues, string>>;
export type BuildResult = { ok: true; change: Record<string, unknown> } | { ok: false; errors: FieldErrors };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME = /^[\p{L}\p{N} ._()&/+-]+$/u;
const ASSET = /^[A-Z0-9]{1,16}$/;
const PAIR = /^[A-Z0-9]{2,16}\/[A-Z0-9]{2,16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const list = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The same tripwire patterns svc-pay applies to free text (`registries/secret-guard.ts`), so the founder hears "this looks like
 * a key" before the round trip. The server still decides; this only saves a trip.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PGP)/i,
  /\b0x[0-9a-fA-F]{64}\b/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\b(?:api[ _-]?key|api[ _-]?secret|secret|passphrase|password|private[ _-]?key|token|bearer)\b\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/,
];

export function looksSecretLike(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

function checkCommon(values: RegistryFormValues, errors: FieldErrors): void {
  const reason = values.reason.trim();
  if (reason.length < 3) errors.reason = 'Say why you are making this change (at least 3 characters). It is saved in the history.';
  else if (reason.length > 500) errors.reason = 'Keep the reason under 500 characters.';
  else if (looksSecretLike(reason)) errors.reason = 'This looks like a key or password. Never put credentials in a registry.';
}

function checkName(values: RegistryFormValues, errors: FieldErrors): void {
  const name = values.displayName.trim();
  if (name === '') errors.displayName = 'Give it a name people will recognise.';
  else if (name.length > 80) errors.displayName = 'Keep the name under 80 characters.';
  else if (!NAME.test(name)) errors.displayName = 'Use letters, digits, spaces and . _ ( ) & / + - only.';
  else if (looksSecretLike(name)) errors.displayName = 'This looks like a key or password. Never put credentials in a registry.';
}

function optionalDecimal(text: string, field: keyof RegistryFormValues, label: string, errors: FieldErrors): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!isDecimalString(trimmed)) {
    errors[field] = `${label} must be a plain number such as 1500 or 0.25 (no commas, no minus sign, at most 18 decimal places).`;
    return null;
  }
  return trimmed;
}

function optionalInt(
  text: string,
  field: keyof RegistryFormValues,
  label: string,
  min: number,
  max: number,
  errors: FieldErrors,
): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) {
    errors[field] = `${label} must be a whole number from ${min} to ${max}.`;
    return null;
  }
  return Number(trimmed);
}

/**
 * Turn typed values into the exact body `founderAdmin.registries.<kind>.save`
 * wants (without the approval fields), or say what is wrong with each field.
 * `expectedVersion` is null for a new entry, else the version the form loaded.
 */
export function buildChange(kind: RegistryKind, values: RegistryFormValues, expectedVersion: number | null): BuildResult {
  const errors: FieldErrors = {};
  checkCommon(values, errors);
  const reason = values.reason.trim();

  if (kind === 'venue') {
    const venueId = values.venueId.trim();
    if (venueId === '' || venueId.length > 40 || !SLUG.test(venueId))
      errors.venueId = 'Use lowercase words joined by hyphens, for example "binance-testnet" (40 characters at most).';
    checkName(values, errors);
    if (values.mode === 'live')
      errors.mode = 'Live venues are switched off until Nitro and Phantom turn them on. Choose testnet or disabled.';
    else if (values.mode !== 'testnet' && values.mode !== 'disabled') errors.mode = 'Choose disabled or testnet.';
    const priority = optionalInt(values.priority, 'priority', 'Priority', 0, 100_000, errors);
    if (priority === null && errors.priority === undefined) errors.priority = 'Set a priority. Lower numbers are tried first.';
    const minOrder = optionalDecimal(values.minOrder, 'minOrder', 'The smallest order', errors);
    const maxOrder = optionalDecimal(values.maxOrder, 'maxOrder', 'The largest order', errors);
    if (minOrder !== null && maxOrder !== null && compareDecimal(minOrder, maxOrder) === 1)
      errors.minOrder = 'The smallest order cannot be larger than the largest order.';
    const pairs = [...new Set(list(values.supportedPairs.toUpperCase()))];
    const badPair = pairs.find((p) => !PAIR.test(p));
    if (badPair) errors.supportedPairs = `"${badPair}" is not a pair. Write pairs as BASE/QUOTE, for example USDT/USD.`;
    else if (pairs.length > 200) errors.supportedPairs = 'At most 200 pairs.';
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      change: {
        venueId,
        displayName: values.displayName.trim(),
        mode: values.mode,
        priority,
        enabled: values.enabled,
        minOrder,
        maxOrder,
        supportedPairs: pairs,
        expectedVersion,
        reason,
      },
    };
  }

  if (kind === 'network') {
    const networkId = values.networkId.trim();
    if (networkId === '' || networkId.length > 40 || !SLUG.test(networkId))
      errors.networkId = 'Use lowercase words joined by hyphens, for example "ethereum-sepolia" (40 characters at most).';
    checkName(values, errors);
    const assets = [...new Set(list(values.assetCodes.toUpperCase()))];
    const badAsset = assets.find((a) => !ASSET.test(a));
    if (badAsset) errors.assetCodes = `"${badAsset}" is not an asset code. Use upper-case letters and digits, for example USDT.`;
    else if (assets.length > 100) errors.assetCodes = 'At most 100 assets.';
    const confirmations = optionalInt(values.confirmationsRequired, 'confirmationsRequired', 'Confirmations', 1, 100_000, errors);
    const source = values.feeEstimateSource.trim();
    if (!['', 'fixed', 'venue_quote', 'chain_estimate'].includes(source))
      errors.feeEstimateSource = 'Choose where the fee estimate comes from.';
    let amount = optionalDecimal(values.feeEstimateAmount, 'feeEstimateAmount', 'The fixed fee', errors);
    if (source === 'fixed' && amount === null && errors.feeEstimateAmount === undefined)
      errors.feeEstimateAmount = 'A fixed fee source needs an amount.';
    if (source !== 'fixed') {
      if (amount !== null) errors.feeEstimateAmount = 'An amount belongs only to the fixed fee source. Clear it or choose "fixed".';
      amount = null;
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      change: {
        networkId,
        displayName: values.displayName.trim(),
        assetCodes: assets,
        confirmationsRequired: confirmations,
        enabled: values.enabled,
        feeEstimateSource: source === '' ? null : source,
        feeEstimateAmount: amount,
        expectedVersion,
        reason,
      },
    };
  }

  const assetCode = values.assetCode.trim().toUpperCase();
  if (!ASSET.test(assetCode)) errors.assetCode = 'Use upper-case letters and digits, for example USDT.';
  const networkId = values.networkId.trim();
  if (networkId === '' || networkId.length > 40 || !SLUG.test(networkId))
    errors.networkId = 'Use the id of an existing network, lowercase words joined by hyphens.';
  const allow = [...new Set(list(values.merchantAllow).map((x) => x.toLowerCase()))];
  const deny = [...new Set(list(values.merchantDeny).map((x) => x.toLowerCase()))];
  const badAllow = allow.find((x) => !UUID.test(x));
  const badDeny = deny.find((x) => !UUID.test(x));
  if (badAllow) errors.merchantAllow = `"${badAllow}" is not a merchant id (a UUID).`;
  if (badDeny) errors.merchantDeny = `"${badDeny}" is not a merchant id (a UUID).`;
  const max = optionalDecimal(values.maxSinglePayout, 'maxSinglePayout', 'The largest single payout', errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    change: {
      assetCode,
      networkId,
      payoutAllowed: values.payoutAllowed,
      merchantAllow: allow,
      merchantDeny: deny,
      maxSinglePayout: max,
      expectedVersion,
      reason,
    },
  };
}

/** Server-side re-check of a change that arrives from the browser: keys and primitive types only. */
const CHANGE_KEYS: Record<RegistryKind, readonly string[]> = {
  venue: ['venueId', 'displayName', 'mode', 'priority', 'enabled', 'minOrder', 'maxOrder', 'supportedPairs', 'expectedVersion', 'reason'],
  network: [
    'networkId',
    'displayName',
    'assetCodes',
    'confirmationsRequired',
    'enabled',
    'feeEstimateSource',
    'feeEstimateAmount',
    'expectedVersion',
    'reason',
  ],
  wallet_route: [
    'assetCode',
    'networkId',
    'payoutAllowed',
    'merchantAllow',
    'merchantDeny',
    'maxSinglePayout',
    'expectedVersion',
    'reason',
  ],
};

/**
 * The BFF accepts only the documented keys (no `apiKey`, no `secret`, no extras)
 * and then asks the service, which validates fully. Returns the change with the
 * approval pair added when both are present.
 */
export function acceptChange(kind: RegistryKind, raw: unknown): Record<string, unknown> | null {
  if (!rec(raw)) return null;
  const allowed = new Set([...CHANGE_KEYS[kind], 'approvalId', 'operationId']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  for (const key of CHANGE_KEYS[kind]) if (!(key in raw)) return null;
  for (const value of Object.values(raw)) {
    const t = typeof value;
    if (value === null || t === 'string' || t === 'number' || t === 'boolean') continue;
    if (Array.isArray(value) && value.every(str)) continue;
    return null;
  }
  return raw;
}

// ── plain-English refusals ──────────────────────────────────────────────────
export interface PlainRefusal {
  readonly title: string;
  readonly body: string;
  readonly next: string;
}

const COPY: Record<string, PlainRefusal> = {
  'registries.live_mode_refused': {
    title: 'Live venues are not allowed yet',
    body: 'Only disabled and testnet venues can be saved. Live trading stays off until Nitro and Phantom switch it on.',
    next: 'Choose testnet or disabled and review again.',
  },
  'registries.venue_unknown': {
    title: 'This system has no adapter for that venue',
    body: 'A venue can only be listed here if the platform already has code to talk to it.',
    next: 'Check the venue id, or ask engineering to add the adapter first.',
  },
  'registries.not_found': {
    title: 'That entry does not exist',
    body: 'You are editing something that is not in the registry.',
    next: 'Go back to the list and open it from there.',
  },
  'registries.already_exists': {
    title: 'Someone already created this entry',
    body: 'An entry with the same id was saved first.',
    next: 'Open the existing entry and edit it instead.',
  },
  'registries.version_conflict': {
    title: 'This entry changed while you were editing',
    body: 'Another change was saved after you opened it, so saving now would overwrite it.',
    next: 'Reload the entry, redo your edit and review again.',
  },
  'registries.create_must_be_inert': {
    title: 'New entries start switched off',
    body: 'A new entry cannot be created switched on. Switching something on is its own change and needs a second founder.',
    next: 'Create it switched off, then enable it as a separate change.',
  },
  'registries.limits_inverted': {
    title: 'The smallest order is larger than the largest',
    body: 'The minimum must not be above the maximum.',
    next: 'Fix the two order limits and review again.',
  },
  'registries.network_unknown': {
    title: 'That network is not in the registry',
    body: 'A wallet route must point at a network that already exists.',
    next: 'Create the network first, then add the route.',
  },
  'registries.asset_not_on_network': {
    title: 'That network does not carry this asset',
    body: 'The route asks for an asset the network is not set up to handle.',
    next: 'Add the asset to the network, or pick another network.',
  },
  'registries.not_routable': {
    title: 'This entry is not fully set up',
    body: 'It cannot be switched on while required values are still blank.',
    next: 'Fill in the missing values first.',
  },
  'registries.enabled_needs_testnet': {
    title: 'Only testnet venues can be switched on',
    body: 'A venue has to be in testnet mode before it can be enabled.',
    next: 'Set the mode to testnet, then enable it.',
  },
  'registries.secret_like_value': {
    title: 'That text looks like a password or key',
    body: 'Registries never store credentials.',
    next: 'Remove the secret from the name or reason.',
  },
  missing_operator: {
    title: 'A second founder has to approve this',
    body: 'This change needs a different founder to approve it, and none has.',
    next: 'Ask the second founder to approve it in step 2, then save again.',
  },
  'action_approval.same_person': {
    title: 'You cannot approve your own change',
    body: 'Dual control needs two different founders.',
    next: 'Ask the other founder to open this page in their own sign-in.',
  },
  'action_approval.not_found': {
    title: 'No approval with that reference',
    body: 'The approval reference was not found.',
    next: 'Check you copied the whole reference, or start a new request.',
  },
  'action_approval.not_pending': {
    title: 'That approval has already been decided',
    body: 'It is no longer waiting for a decision.',
    next: 'Start a new request if the change still needs approving.',
  },
  'action_approval.expired': {
    title: 'That approval has run out of time',
    body: 'Approvals only last a short while.',
    next: 'Start a new request and ask the second founder again.',
  },
  'action_approval.consumed': {
    title: 'That approval was already used',
    body: 'Each approval works for one save only.',
    next: 'Start a new request.',
  },
  'action_approval.payload_mismatch': {
    title: 'The approval is for a different change',
    body: 'You changed something after the second founder approved. An approval only covers the exact change it was given for.',
    next: 'Review the change again and ask for a fresh approval.',
  },
  'action_approval.target_mismatch': {
    title: 'The approval is for something else',
    body: 'It was issued for a different action.',
    next: 'Start a new request from this page.',
  },
  'action_approval.not_approved': {
    title: 'The second founder has not approved yet',
    body: 'The request is still waiting.',
    next: 'Ask them to approve it, then save.',
  },
  'action_approval.not_requester': {
    title: 'Only the person who asked can do that',
    body: 'This action belongs to the founder who made the request.',
    next: 'Ask the founder who started the request.',
  },
  'action_approval.already_terminal': {
    title: 'That request is already closed',
    body: 'It was approved, rejected, used or withdrawn before.',
    next: 'Start a new request if you still need one.',
  },
  'action_approval.identity_unwired': {
    title: 'Second-founder approval is not connected on this deployment',
    body: 'The identity service that issues approvals is not configured here, so a change that needs two founders cannot be saved.',
    next: 'Ask engineering to connect it. Nothing was changed.',
  },
  'action_approval.missing': {
    title: 'This change needs a second founder first',
    body: 'No approval was supplied.',
    next: 'Complete step 2 (request and get approval), then save.',
  },
  'operator.denied': {
    title: 'Your founder session is not allowed to do this',
    body: 'The service could not confirm you as an enabled founder.',
    next: 'Sign out and in again. If it persists, another founder must check your access.',
  },
  'mfa.required': {
    title: 'Your sign-in is missing the second factor',
    body: 'Founder actions need a session that completed multi-factor sign-in.',
    next: 'Sign out and in again with your authenticator or passkey.',
  },
};

const BY_STATUS: Record<number, PlainRefusal> = {
  400: {
    title: 'The service did not accept these values',
    body: 'One of the values failed the service’s own check.',
    next: 'Review the form and try again.',
  },
  401: { title: 'You are signed out', body: 'Your founder session ended.', next: 'Sign in again.' },
  403: { title: 'Not allowed', body: 'The service refused this request.', next: 'Check your founder access.' },
  404: { title: 'Not found', body: 'The service could not find what you asked for.', next: 'Go back to the list.' },
  409: { title: 'This conflicts with a newer change', body: 'The data changed under you.', next: 'Reload and try again.' },
  412: {
    title: 'A condition was not met',
    body: 'The service refused because a rule was not satisfied.',
    next: 'Review the form and try again.',
  },
};

export function explainRefusal(code: string | null, message: string, status: number): PlainRefusal {
  if (code !== null && COPY[code]) return COPY[code]!;
  const embedded = /\b(registries\.[a-z_]+|action_approval\.[a-z_]+)\b/.exec(message)?.[1];
  if (embedded && COPY[embedded]) return COPY[embedded]!;
  if (/secret_like_value/.test(message)) return COPY['registries.secret_like_value']!;
  if (status >= 500)
    return {
      title: 'The service could not answer',
      body: 'Nothing was saved.',
      next: 'Wait a moment and try again. If it keeps failing, tell engineering.',
    };
  return (
    BY_STATUS[status] ?? { title: 'The service refused this change', body: 'Nothing was saved.', next: 'Review the form and try again.' }
  );
}

// ── plain-English summary of a change ───────────────────────────────────────
const FIELD_LABEL: Record<string, string> = {
  venueId: 'Venue id',
  networkId: 'Network id',
  assetCode: 'Asset',
  displayName: 'Name',
  mode: 'Mode',
  priority: 'Priority (lower is tried first)',
  enabled: 'Switched on',
  minOrder: 'Smallest order',
  maxOrder: 'Largest order',
  supportedPairs: 'Pairs',
  assetCodes: 'Assets',
  confirmationsRequired: 'Confirmations required',
  feeEstimateSource: 'Fee estimate from',
  feeEstimateAmount: 'Fixed fee',
  payoutAllowed: 'Payouts allowed',
  merchantAllow: 'Only these merchants',
  merchantDeny: 'Never these merchants',
  maxSinglePayout: 'Largest single payout',
  reason: 'Reason',
};

export interface SummaryRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.join(', ');
  return String(value);
}

/** Every business field of a change, in reading order, without the version or approval plumbing. */
export function summariseChange(kind: RegistryKind, change: Record<string, unknown>): SummaryRow[] {
  return CHANGE_KEYS[kind]
    .filter((key) => key !== 'expectedVersion')
    .map((key) => ({ key, label: FIELD_LABEL[key] ?? key, value: show(change[key]) }));
}

/** Rows whose value differs from the entry as loaded; a create has no "before", so every row is new. */
export function changedKeys(kind: RegistryKind, before: Record<string, unknown> | null, after: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const row of summariseChange(kind, after)) {
    if (before === null || show(before[row.key]) !== row.value) out.add(row.key);
  }
  return out;
}
