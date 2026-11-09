// hand-declared-ok: svc-trade's /api/v1/venue/* (src/venue/user-venue-rest.ts) has no schema in packages/contracts; this mirrors its answers
/**
 * The person's own account on the venue, through svc-trade's user-venue door (J-wallet-09 #3, #5). The venue is the
 * record: every figure here is the venue's, with the venue's as-of time, as decimal strings (never a number). Nothing
 * here moves money: a deposit is the person's own token transfer, sent from their wallet to the venue's deposit
 * address, and a withdrawal is the venue's action, signed in their wallet. INTAFACED moves nothing and the ledger
 * posts nothing.
 */
import { z } from 'zod';
import type { ApiClient, RefusalReason } from '../../../shared/api';

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const maybeKnown = z.union([z.object({ known: z.literal(true), value: decimal }), z.object({ known: z.literal(false) })]);

export const venueDepositRouteSchema = z.object({
  chainId: z.number().int().positive(),
  token: address,
  tokenDecimals: z.number().int().min(0).max(18),
  address,
  asset: z.string().min(1),
});
export type VenueDepositRoute = z.infer<typeof venueDepositRouteSchema>;

export const venueStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(false),
    refusal: z.object({ code: z.string(), detail: z.string().optional() }).passthrough(),
  }),
  z
    .object({
      enabled: z.literal(true),
      available: z.literal(true),
      test: z.boolean(),
      label: z.literal('TEST').optional(),
      chainId: z.number().int().nullable(),
      deposit: venueDepositRouteSchema.nullable().optional(),
    })
    .passthrough(),
]);
export type VenueStatus = z.infer<typeof venueStatusSchema>;

export const venueBalancesSchema = z.object({
  venueId: z.string(),
  asOf: z.string(),
  value: z.array(z.object({ asset: z.string(), free: decimal, locked: decimal, total: decimal })),
});

export const venueWithdrawalSchema = z.object({
  nonce: z.string(),
  asset: z.string(),
  amount: decimal,
  destination: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed']),
  fee: maybeKnown,
  networkFee: maybeKnown,
});
export type VenueWithdrawal = z.infer<typeof venueWithdrawalSchema>;
export const venueWithdrawalReadSchema = z.object({ venueId: z.string(), asOf: z.string(), value: venueWithdrawalSchema.nullable() });

const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const venuePreparedSchema = z.object({
  actionKey: z.string(),
  reused: z.boolean(),
  signed: z.boolean(),
  prepared: z
    .object({
      nonce: z.string(),
      digest: z.string(),
      signer: z.object({ role: z.enum(['owner', 'agent']), address: z.string() }),
      typedData: typedDataSchema,
    })
    .passthrough(),
});
export type VenuePrepared = z.infer<typeof venuePreparedSchema>;

const refusalSchema = z.object({ code: z.string(), detail: z.string() }).passthrough();
export const venueSubmittedSchema = z.object({
  actionKey: z.string(),
  outcome: z.union([
    z.object({ definite: z.literal(true), accepted: z.literal(true), venueRef: z.string().nullable(), asOf: z.string() }).passthrough(),
    z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: z.string() }).passthrough(),
    z.object({ definite: z.literal(false), reason: z.string() }),
  ]),
  readBack: z.union([z.object({ nonce: z.string() }), z.object({ venueClientOrderId: z.string() }), z.null()]),
});
export type VenueSubmitted = z.infer<typeof venueSubmittedSchema>;

/**
 * The EIP-712 domain types for a venue payload, as the wallet hashes them: the venue's domain fields in the standard
 * order. The venue sends the domain without declaring it; the wallet sheet refuses a domain it cannot see declared.
 */
const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
] as const;
export function withDomainTypes(typed: VenuePrepared['prepared']['typedData']) {
  const declared = DOMAIN_FIELDS.filter((field) => typed.domain[field.name] !== undefined).map((field) => ({ ...field }));
  return { ...typed, types: { EIP712Domain: declared, ...typed.types } };
}

export function createVenueAccountApi(api: ApiClient) {
  return {
    status: (signal?: AbortSignal) => api.rest('/venue/status', venueStatusSchema, { signal }),
    balances: (owner: string, signal?: AbortSignal) => api.rest('/venue/balances', venueBalancesSchema, { query: { owner }, signal }),
    withdrawal: (owner: string, nonce: string, signal?: AbortSignal) =>
      api.rest(`/venue/withdrawals/${encodeURIComponent(nonce)}`, venueWithdrawalReadSchema, { query: { owner }, signal }),
    prepareWithdrawal: (input: {
      owner: string;
      asset: string;
      amount: string;
      destination: string;
      withdrawalKey: string;
      stepUpApprovalId: string | null;
    }) =>
      api.rest('/venue/prepare', venuePreparedSchema, {
        method: 'POST',
        body: {
          owner: input.owner,
          signer: { role: 'owner', address: input.owner },
          intent: {
            kind: 'withdraw',
            asset: input.asset,
            amount: input.amount,
            destination: input.destination,
            withdrawalKey: input.withdrawalKey,
          },
          stepUpApprovalId: input.stepUpApprovalId,
        },
      }),
    submit: (actionKey: string, signature: { digest: string; signature: string; signedBy: string }) =>
      api.rest('/venue/submit', venueSubmittedSchema, { method: 'POST', body: { actionKey, signature } }),
  };
}
export type VenueAccountApi = ReturnType<typeof createVenueAccountApi>;

/** A decimal string with trailing zeros dropped (`25.000000` → `25`), for display; never parsed into a number. */
export function plainDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/** A typed amount in the canonical decimal form svc-trade hashes for the step-up (`010.50` → `10.5`); null when not a decimal. */
export function canonicalAmount(amount: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(amount.trim());
  if (!match) return null;
  const whole = BigInt(match[1]!).toString();
  const frac = (match[2] ?? '').replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** A venue decimal string as a scaled bigint (18 places), to compare two figures exactly; null when it is not a decimal. */
export function scaledDecimal(value: string): bigint | null {
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,18}))?$/.exec(value.trim());
  if (!match) return null;
  const units = BigInt(match[2]!) * 10n ** 18n + BigInt((match[3] ?? '').padEnd(18, '0') || '0');
  return match[1] === '-' ? -units : units;
}

/** A typed amount (`12.5`) in token base units, or null when it is not a positive decimal within the token's decimals. */
export function toTokenUnits(amount: string, decimals: number): bigint | null {
  const text = amount.trim();
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const frac = match[2] ?? '';
  if (frac.length > decimals) return null;
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return units > 0n ? units : null;
}

/**
 * The withdrawal's business key: the owner and the moment this withdrawal was asked for. The room makes it once per
 * withdrawal and keeps it until the venue answers definitely (`withdrawalAfter`), so a retry of the same withdrawal is
 * the same key (one prepared action, one wallet prompt), and only a new withdrawal is a new key.
 */
export function venueWithdrawalKey(owner: string, askedAt: number): string {
  return `venue-withdraw:${owner.toLowerCase()}:${askedAt}`;
}

/** A request whose answer did not arrive (or could not be read): it may have reached svc-trade or the venue. */
export function outcomeUnknown(reason: RefusalReason): boolean {
  return reason === 'unreachable' || reason === 'uncertain' || reason === 'aborted' || reason === 'invalid_response';
}

/**
 * What the room does with a withdrawal's key after one step answers:
 *   · `retry`: nothing reached the venue as a signed withdrawal, or the answer is not known before signing: the ask stays,
 *     with the SAME key, so a retry is the same prepared action and never a second withdrawal;
 *   · `new`: the venue or svc-trade answered definitely that this withdrawal will not happen: the next one is a new key;
 *   · `follow`: the venue took it, or may have (not definite): no new withdrawal starts until its record reads back;
 *   · `follow-then-retry`: the submit's answer was lost: the record is followed by its nonce, and if it never shows,
 *     the ask comes back with the SAME key, so the retry can't be a second withdrawal.
 */
export type WithdrawalNext = 'retry' | 'new' | 'follow' | 'follow-then-retry';
export function withdrawalAfter(
  step:
    | { at: 'prepare'; failed: RefusalReason }
    | { at: 'sign'; signed: false }
    | { at: 'submit'; failed: RefusalReason }
    | { at: 'submit'; definite: boolean; accepted: boolean },
): WithdrawalNext {
  if (step.at === 'sign') return 'retry';
  if ('failed' in step) {
    if (!outcomeUnknown(step.failed)) return 'new';
    return step.at === 'prepare' ? 'retry' : 'follow-then-retry';
  }
  return step.definite && !step.accepted ? 'new' : 'follow';
}
