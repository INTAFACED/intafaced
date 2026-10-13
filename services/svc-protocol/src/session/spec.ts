import { z } from 'zod';
import { decodeAbiParameters, encodeAbiParameters, isAddress, keccak256, toFunctionSelector, getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * SESSION KEY SCOPE — the TypeScript half of `contracts/SessionKeyLib.sol`.
 *
 * Read this next to that file; they are one design in two languages.
 *
 * **What this file is not.** It is not the enforcement. Every rule here is
 * enforced on-chain by SmartAccount on every call, and would still be enforced
 * if this service were compromised, offline, or hostile. What this file does is
 * (a) refuse to build a spec the contract would reject, so a user never signs a
 * transaction that reverts, and (b) produce exactly the bytes the contract
 * hashes, so the commitment the user signs is the commitment the chain stores.
 *
 * If this file and the contract ever disagree, the contract is right.
 */

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ── Limits (must match SessionKeyLib) ───────────────────────────────────────

/** `SessionKeyLib.MAX_SESSION_DURATION` — 30 days. No permanent grants. */
export const MAX_SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
export const MAX_TARGETS = 32;
export const MAX_SELECTORS = 32;

/**
 * Selectors a session key may never be given.
 *
 * Every one of these either moves a token out of the account or hands another
 * address the standing right to. A session key trades THROUGH a venue using an
 * allowance the owner set; it never moves the asset and never creates an
 * allowance of its own.
 *
 * Derived from the signatures rather than pasted, and `spec.test.ts` asserts the
 * derived values appear verbatim in SessionKeyLib.sol — which is how the two
 * languages stay in lockstep without a Solidity compiler in the loop.
 */
export const FORBIDDEN_SIGNATURES = [
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'increaseAllowance(address,uint256)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
  'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  // Permit2 `approve(token, spender, amount, expiration)`.
  'approve(address,address,uint160,uint48)',
  'transferOwnership(address)',
  'upgradeTo(address)',
  'upgradeToAndCall(address,bytes)',
] as const;

/** selector → the signature it came from, for error messages a human can act on. */
export const FORBIDDEN_SELECTORS: ReadonlyMap<Hex, string> = new Map(
  FORBIDDEN_SIGNATURES.map((sig) => [toFunctionSelector(sig).toLowerCase() as Hex, sig]),
);

export function isOutboundTransferSelector(selector: Hex): boolean {
  return FORBIDDEN_SELECTORS.has(selector.toLowerCase() as Hex);
}

/**
 * Calls a session may be allowlisted for whose calldata names who receives the
 * output, and the position of that argument. For each, the recipient must be the
 * granting account — a session trades FOR its account, never for a stranger,
 * even when the owner's token allowance is what pays for the trade.
 *
 * Found by sweeping the non-view ABIs the session could be pointed at
 * (`contracts/amm`, `contracts/router`, `src/amm/build.ts`, the vaults) for an
 * address argument named `to`; `spec.test.ts` repeats that sweep against the
 * compiled ABIs so a new recipient-bearing function cannot slip in unlisted.
 *
 * Mirrors `SessionKeyLib.recipientOffset`. `spec.test.ts` asserts every selector
 * and byte offset (4 + 32 * recipientArg) against the Solidity source.
 */
export const RECIPIENT_SCOPED_CALLS = [
  // ConstantProductPool.swapExactIn(tokenIn, amountIn, minAmountOut, to)
  { signature: 'swapExactIn(address,uint256,uint256,address)', recipientArg: 3 },
  // SovereignRouter.swapExactIn(pool, tokenIn, amountIn, minAmountOut, to)
  { signature: 'swapExactIn(address,address,uint256,uint256,address)', recipientArg: 4 },
  // ConstantProductPool.swap(amount0Out, amount1Out, to)
  { signature: 'swap(uint256,uint256,address)', recipientArg: 2 },
  // ConstantProductPool.mint(to, amount0Desired, amount1Desired) — LP credited to `to`
  { signature: 'mint(address,uint256,uint256)', recipientArg: 0 },
  // ConstantProductPool.burn(to, liquidity) — underlying paid to `to`
  { signature: 'burn(address,uint256)', recipientArg: 0 },
  // CrewVault.proposeSpend(to, amount)
  { signature: 'proposeSpend(address,uint256)', recipientArg: 0 },
  // SovereignNft.setTokenRoyalty(tokenId, receiver, bps) — royalties paid to `receiver`
  { signature: 'setTokenRoyalty(uint256,address,uint16)', recipientArg: 1 },
] as const;

/** selector → byte offset of the 32-byte recipient word in calldata. */
export const RECIPIENT_OFFSETS: ReadonlyMap<Hex, number> = new Map(
  RECIPIENT_SCOPED_CALLS.map((c) => [toFunctionSelector(c.signature).toLowerCase() as Hex, 4 + 32 * c.recipientArg]),
);

// ── The spec ────────────────────────────────────────────────────────────────

/**
 * A granted session, in memory.
 *
 * `spendLimitWei` is a bigint here and a decimal string on the wire — never a
 * `number`. 2^53 wei is 0.009 ETH; a float would round away a user's cap.
 */
export interface SessionSpec {
  readonly key: Address;
  /** Unix seconds. 0 = live immediately. */
  readonly validAfter: number;
  /** Unix seconds. Mandatory, and never more than 30 days out. */
  readonly validUntil: number;
  /** Cumulative cap on native value, in wei. */
  readonly spendLimitWei: bigint;
  readonly targets: readonly Address[];
  readonly selectors: readonly Hex[];
}

const addressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), { message: 'not an EVM address' })
  .transform((v) => toChecksum(v));

const selectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, 'a selector is 4 bytes')
  .transform((v) => v.toLowerCase() as Hex);

const uint48Schema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 48 - 1);

/** Wire shape. Amounts arrive as decimal strings, per the money law. */
export const sessionSpecInputSchema = z.object({
  key: addressSchema,
  validAfter: uint48Schema.default(0),
  validUntil: uint48Schema,
  spendLimitWei: z.string().regex(/^\d+$/, 'wei must be a non-negative integer string'),
  targets: z.array(addressSchema),
  selectors: z.array(selectorSchema),
});

export type SessionSpecInput = z.infer<typeof sessionSpecInputSchema>;

/** The tuple SmartAccount hashes. Full `abi.encode`, never packed. */
export const SESSION_SPEC_ABI = [
  { name: 'key', type: 'address' },
  { name: 'validAfter', type: 'uint48' },
  { name: 'validUntil', type: 'uint48' },
  { name: 'spendLimitWei', type: 'uint128' },
  { name: 'targets', type: 'address[]' },
  { name: 'selectors', type: 'bytes4[]' },
] as const;

export function encodeSessionSpec(spec: SessionSpec): Hex {
  return encodeAbiParameters(SESSION_SPEC_ABI, [
    spec.key,
    spec.validAfter,
    spec.validUntil,
    spec.spendLimitWei,
    [...spec.targets],
    [...spec.selectors],
  ]);
}

export function decodeSessionSpec(encoded: Hex): SessionSpec {
  const [key, validAfter, validUntil, spendLimitWei, targets, selectors] = decodeAbiParameters(SESSION_SPEC_ABI, encoded);
  return Object.freeze({
    key: toChecksum(key),
    validAfter: Number(validAfter),
    validUntil: Number(validUntil),
    spendLimitWei,
    targets: targets.map((t) => toChecksum(t)),
    selectors: selectors.map((s) => s.toLowerCase() as Hex),
  });
}

/**
 * The commitment stored on-chain. The user signs a transaction containing the
 * full spec; the account stores this hash and re-checks it on every call, so a
 * granted session's scope is immutable for its lifetime.
 */
export function hashSessionSpec(spec: SessionSpec): Hex {
  return keccak256(encodeSessionSpec(spec));
}

// ── Validation ──────────────────────────────────────────────────────────────

export type SessionScopeCode =
  | 'session.key_required'
  | 'session.expiry_required'
  | 'session.expiry_in_past'
  | 'session.duration_exceeded'
  | 'session.targets_required'
  | 'session.targets_too_many'
  | 'session.zero_target_forbidden'
  | 'session.self_target_forbidden'
  | 'session.duplicate_target'
  | 'session.selectors_required'
  | 'session.selectors_too_many'
  | 'session.fallback_selector_forbidden'
  | 'session.duplicate_selector'
  | 'session.outbound_transfer_forbidden'
  | 'session.spend_limit_overflow';

export class SessionScopeError extends Error {
  constructor(
    readonly code: SessionScopeCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionScopeError';
  }
}

const UINT128_MAX = (1n << 128n) - 1n;

export interface GrantContext {
  /** The smart account granting the session. A session may never call it. */
  account: Address;
  /** Unix seconds. Injected so expiry logic is testable without a clock. */
  now: number;
}

/**
 * Every rule `SessionKeyLib.assertGrantable` enforces, in the same order.
 *
 * Throws. It does not return a "warning" — a scope that the chain would reject
 * is not something to render a caveat about, it is something that must not
 * become a transaction.
 */
export function assertGrantableSession(spec: SessionSpec, ctx: GrantContext): void {
  if (!isAddress(spec.key, { strict: false }) || spec.key === ZERO_ADDRESS) {
    throw new SessionScopeError('session.key_required', 'A session needs a key');
  }

  if (spec.validUntil === 0) {
    throw new SessionScopeError('session.expiry_required', 'A session key must expire. There is no permanent delegation on this plane.');
  }
  if (spec.validUntil <= ctx.now) {
    throw new SessionScopeError('session.expiry_in_past', `validUntil ${spec.validUntil} is not in the future`);
  }

  const startsAt = Math.max(spec.validAfter, ctx.now);
  // A window that closes before it opens is expiry-in-the-past by another name.
  // The contract checks this explicitly, so this side must too — a spec that
  // passes here and reverts on chain is worse than one rejected outright.
  if (spec.validUntil <= startsAt) {
    throw new SessionScopeError('session.expiry_in_past', `validUntil ${spec.validUntil} is not after validAfter ${spec.validAfter}`);
  }
  if (spec.validUntil - startsAt > MAX_SESSION_DURATION_SECONDS) {
    throw new SessionScopeError(
      'session.duration_exceeded',
      `A session may not run longer than ${MAX_SESSION_DURATION_SECONDS}s (30 days)`,
    );
  }

  if (spec.targets.length === 0) {
    throw new SessionScopeError('session.targets_required', 'A session needs an explicit target allowlist');
  }
  if (spec.targets.length > MAX_TARGETS) {
    throw new SessionScopeError('session.targets_too_many', `At most ${MAX_TARGETS} targets`);
  }

  const seenTargets = new Set<string>();
  for (const target of spec.targets) {
    const lower = target.toLowerCase();
    if (lower === ZERO_ADDRESS.toLowerCase()) {
      throw new SessionScopeError('session.zero_target_forbidden', 'The zero address is not a target');
    }
    // The rule that closes every escalation path at once: a session that cannot
    // call its own account cannot grant itself more power, rotate the owner, or
    // revoke the user's control.
    if (lower === ctx.account.toLowerCase()) {
      throw new SessionScopeError('session.self_target_forbidden', 'A session key may never call the account itself');
    }
    if (seenTargets.has(lower)) {
      throw new SessionScopeError('session.duplicate_target', `Duplicate target ${target}`);
    }
    seenTargets.add(lower);
  }

  if (spec.selectors.length === 0) {
    throw new SessionScopeError('session.selectors_required', 'A session needs an explicit selector allowlist');
  }
  if (spec.selectors.length > MAX_SELECTORS) {
    throw new SessionScopeError('session.selectors_too_many', `At most ${MAX_SELECTORS} selectors`);
  }

  const seenSelectors = new Set<string>();
  for (const selector of spec.selectors) {
    const lower = selector.toLowerCase() as Hex;
    if (lower === '0x00000000') {
      throw new SessionScopeError(
        'session.fallback_selector_forbidden',
        'A zero selector is a raw fallback call — an unbounded hole in an exact allowlist',
      );
    }
    const signature = FORBIDDEN_SELECTORS.get(lower);
    if (signature) {
      // THE rule. Doctrine §16.10 in one branch.
      throw new SessionScopeError(
        'session.outbound_transfer_forbidden',
        `A session key may never be granted "${signature}" (${lower}). ` + 'Withdrawal power belongs to the owner key and nowhere else.',
      );
    }
    if (seenSelectors.has(lower)) {
      throw new SessionScopeError('session.duplicate_selector', `Duplicate selector ${lower}`);
    }
    seenSelectors.add(lower);
  }

  if (spec.spendLimitWei < 0n || spec.spendLimitWei > UINT128_MAX) {
    throw new SessionScopeError('session.spend_limit_overflow', 'spendLimitWei does not fit in uint128');
  }
}

/**
 * The only supported way to build a SessionSpec.
 *
 * Validation happens inside the constructor, not beside it, so there is no code
 * path in this service that produces an unvalidated spec — a session key with
 * withdrawal permission cannot be constructed here, only rejected.
 */
export function createSessionSpec(input: SessionSpecInput, ctx: GrantContext): SessionSpec {
  const spec: SessionSpec = Object.freeze({
    key: input.key,
    validAfter: input.validAfter,
    validUntil: input.validUntil,
    spendLimitWei: BigInt(input.spendLimitWei),
    targets: Object.freeze([...input.targets]),
    selectors: Object.freeze([...input.selectors]),
  });
  assertGrantableSession(spec, ctx);
  return spec;
}

// ── Call-time policy ────────────────────────────────────────────────────────

export type SessionCallCode =
  | 'allowed'
  | 'session.not_yet_valid'
  | 'session.expired'
  | 'session.self_call_forbidden'
  | 'session.target_not_allowed'
  | 'session.calldata_too_short'
  | 'session.selector_not_allowed'
  | 'session.outbound_transfer_forbidden'
  | 'session.recipient_not_account'
  | 'session.recipient_calldata_too_short'
  | 'session.spend_limit_exceeded';

export interface SessionCallDecision {
  readonly allowed: boolean;
  readonly code: SessionCallCode;
  readonly reason: string;
  /** What the cumulative spend becomes if this call proceeds. */
  readonly spentAfterWei: bigint;
}

export interface SessionCallQuery {
  spec: SessionSpec;
  account: Address;
  target: Address;
  value: bigint;
  data: Hex;
  /** Cumulative native value already moved under this session, from the chain. */
  spentWei: bigint;
  now: number;
}

/**
 * Mirrors `SmartAccount.executeWithSession`, decision for decision.
 *
 * Used to tell a user (or an agent) why a call will fail before they pay gas to
 * find out. The chain runs the same checks and does not consult this one.
 */
export function evaluateSessionCall(q: SessionCallQuery): SessionCallDecision {
  const deny = (code: SessionCallCode, reason: string): SessionCallDecision => ({
    allowed: false,
    code,
    reason,
    spentAfterWei: q.spentWei,
  });

  if (q.now < q.spec.validAfter) return deny('session.not_yet_valid', `Session is not valid until ${q.spec.validAfter}`);
  if (q.now >= q.spec.validUntil) return deny('session.expired', `Session expired at ${q.spec.validUntil}`);

  if (q.target.toLowerCase() === q.account.toLowerCase()) {
    return deny('session.self_call_forbidden', 'A session key may never call the account itself');
  }
  if (!q.spec.targets.some((t) => t.toLowerCase() === q.target.toLowerCase())) {
    return deny('session.target_not_allowed', `${q.target} is not in this session's target allowlist`);
  }

  // A bare native transfer has no selector to allowlist, so it is not a scoped
  // call — it is a payment, and a session key does not make those.
  if (q.data.length < 10) {
    return deny('session.calldata_too_short', 'A session call must carry a 4-byte selector');
  }
  const selector = q.data.slice(0, 10).toLowerCase() as Hex;

  if (!q.spec.selectors.some((s) => s.toLowerCase() === selector)) {
    return deny('session.selector_not_allowed', `${selector} is not in this session's selector allowlist`);
  }
  const forbidden = FORBIDDEN_SELECTORS.get(selector);
  if (forbidden) {
    return deny('session.outbound_transfer_forbidden', `"${forbidden}" is never callable by a session key`);
  }

  // Where the call names a recipient, it must be this account. Whole-word
  // compare against the left-padded account, no decoding — exactly
  // `SessionKeyLib.assertRecipientIsAccount`. Dirty high bytes are refused, and
  // calldata that ends before the word is refused, never read as zero.
  const recipientOffset = RECIPIENT_OFFSETS.get(selector);
  if (recipientOffset !== undefined) {
    const start = 2 + recipientOffset * 2;
    const end = start + 64;
    if (q.data.length < end) {
      return deny(
        'session.recipient_calldata_too_short',
        `${selector} names a recipient, but the calldata ends before it. A session call must carry its recipient.`,
      );
    }
    const word = q.data.slice(start, end).toLowerCase();
    const expected = '0'.repeat(24) + q.account.slice(2).toLowerCase();
    if (word !== expected) {
      return deny(
        'session.recipient_not_account',
        `${selector} sends its output to 0x${word}, not to the account ${q.account}. A session key trades for its account only.`,
      );
    }
  }

  const spentAfterWei = q.spentWei + q.value;
  if (spentAfterWei > q.spec.spendLimitWei) {
    return deny('session.spend_limit_exceeded', `${spentAfterWei} wei exceeds the session cap of ${q.spec.spendLimitWei} wei`);
  }

  return { allowed: true, code: 'allowed', reason: 'Within session scope', spentAfterWei };
}
