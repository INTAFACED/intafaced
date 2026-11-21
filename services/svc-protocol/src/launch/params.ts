import { isAddress, parseUnits, getAddress as toChecksum } from 'viem';
import type { Address } from 'viem';

/**
 * TOKEN LAUNCH POLICY — what INTAFACED will put its name on (§8.4).
 *
 * `TokenFactory.sol` is permissionless and enforces only the bounds that keep a
 * token usable at all. This file is the platform's own, stricter opinion, and
 * the split is deliberate:
 *
 *   · the CONTRACT bounds are permanent and apply to everyone, including
 *     callers who never touch this API. They cannot encode platform policy,
 *     because policy changes and immutable code does not.
 *   · these bounds are the SURFACE's. Refusing here refuses a launch through
 *     INTAFACED. It does not, and must not, stop anyone deploying the same
 *     template themselves — that is what §22 means on this plane.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO MONEY IN A `number`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `totalSupply` arrives as a DECIMAL STRING of whole tokens ("1000000",
 * "21000000.5") and becomes a scaled `bigint` here and nowhere else. It is
 * never a JS number at any point, not even briefly for validation — 1e21 is
 * already past `Number.MAX_SAFE_INTEGER`, so a supply that looked fine in a
 * form would arrive on chain rounded, and the token would be permanently wrong
 * with no way to correct it.
 */

/** Mirrors `TokenFactory.MAX_DECIMALS`. */
export const MAX_DECIMALS = 18;
/** Mirrors `TokenFactory.MAX_NAME_BYTES` / `MAX_SYMBOL_BYTES`. */
const MAX_NAME_BYTES = 64;
const MAX_SYMBOL_BYTES = 16;

/**
 * The largest whole-unit supply this surface will launch: 10^20 − 1.
 *
 * Not a contract limit — `SovereignToken` is happy up to `uint256`. It is the
 * point past which the amount stops being representable in the Fiat Plane's
 * `numeric(38,18)`, which is 20 integer digits and 18 fractional. A token whose
 * supply cannot be written down in the ledger cannot be listed, quoted,
 * escrowed or reconciled by anything on the other plane, and discovering that
 * after launch means telling a creator their immutable token is unlistable.
 *
 * PRODUCT DECISION, FLAGGED: this forecloses meme supplies above 10^20 whole
 * units. It is the conservative choice — a creator who is refused can pick a
 * smaller supply, whereas a creator who is allowed through has no recourse at
 * all, ever. If the owner wants larger supplies on a protocol-plane-only basis,
 * widening this constant is a deliberate decision that also needs the listing
 * path to refuse those tokens instead.
 */
export const MAX_WHOLE_SUPPLY = 10n ** 20n - 1n;

export type TokenParamsRefusalCode =
  | 'launch.invalid_name'
  | 'launch.invalid_symbol'
  | 'launch.invalid_decimals'
  | 'launch.invalid_supply'
  | 'launch.supply_out_of_range'
  | 'launch.invalid_recipient';

export class TokenParamsError extends Error {
  constructor(
    readonly code: TokenParamsRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'TokenParamsError';
  }
}

/** What the caller sends. Supply is a decimal string of WHOLE tokens. */
export interface TokenParamsInput {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: string;
  readonly recipient: Address;
}

/** What the contract takes. `totalSupply` is scaled by `decimals`. */
export interface TokenParams {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupply: bigint;
  readonly recipient: Address;
}

/** UTF-8 length, because `bytes(name).length` in Solidity counts bytes, not code units. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Code points a token name must not contain: C0/C1 controls, the soft hyphen,
 * the zero-width and joiner set, the bidirectional overrides and embeddings,
 * and the interlinear annotation marks.
 *
 * Built from numeric ranges rather than written as a character class of
 * literals, for the obvious reason — every one of these is invisible, so a
 * literal class is a line no reviewer can check and no diff can show. Name and
 * symbol are displayed next to a price and are immutable after deployment:
 * U+202E and friends are the standard way to make one token render as another,
 * and there is no moderation action afterwards, only a refusal before.
 */
const DECEPTIVE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x0600, 0x0605], // Arabic number signs (format characters)
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x202a, 0x202e], // bidi embedding + overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xfff9, 0xfffb], // interlinear annotation
];

function findDeceptiveCodePoint(value: string): number | null {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (DECEPTIVE_RANGES.some(([low, high]) => code >= low && code <= high)) return code;
  }
  return null;
}

function assertDisplaySafe(value: string, field: string, code: TokenParamsRefusalCode): void {
  const found = findDeceptiveCodePoint(value);
  if (found !== null) {
    throw new TokenParamsError(
      code,
      `${field} contains U+${found.toString(16).toUpperCase().padStart(4, '0')}, a control, zero-width or ` +
        `bidirectional character. Those are how one token is made to render as another, and a token's ${field} ` +
        `can never be changed after deployment.`,
    );
  }
  if (value.trim() !== value) {
    throw new TokenParamsError(code, `${field} has leading or trailing whitespace, which is invisible and permanent.`);
  }
}

/**
 * Validate and scale. Throws `TokenParamsError` — never returns a corrected
 * value, because silently correcting a launch parameter is how a creator ends
 * up with a token they did not ask for and cannot change.
 */
export function parseTokenParams(input: TokenParamsInput): TokenParams {
  const { name, symbol } = input;

  if (name.length === 0 || utf8Length(name) > MAX_NAME_BYTES) {
    throw new TokenParamsError('launch.invalid_name', `name must be 1-${MAX_NAME_BYTES} UTF-8 bytes, got ${utf8Length(name)}.`);
  }
  assertDisplaySafe(name, 'name', 'launch.invalid_name');

  if (symbol.length === 0 || utf8Length(symbol) > MAX_SYMBOL_BYTES) {
    throw new TokenParamsError('launch.invalid_symbol', `symbol must be 1-${MAX_SYMBOL_BYTES} UTF-8 bytes, got ${utf8Length(symbol)}.`);
  }
  assertDisplaySafe(symbol, 'symbol', 'launch.invalid_symbol');

  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > MAX_DECIMALS) {
    throw new TokenParamsError(
      'launch.invalid_decimals',
      `decimals must be an integer 0-${MAX_DECIMALS}. Above 18 the amount cannot round-trip through the ledger's numeric(38,18).`,
    );
  }

  // Plain decimal string, no exponent, no sign, no separators. `parseUnits`
  // tolerates some of what this rejects; refusing here means the message names
  // the expected format instead of surfacing a library error.
  if (!/^\d+(\.\d+)?$/.test(input.totalSupply)) {
    throw new TokenParamsError(
      'launch.invalid_supply',
      `totalSupply must be a plain decimal string of whole tokens, e.g. "1000000" or "21000000.5" — got ` +
        `"${input.totalSupply}". Money is never a number on this surface.`,
    );
  }

  const [whole = '0', fraction = ''] = input.totalSupply.split('.');
  if (fraction.length > input.decimals) {
    throw new TokenParamsError(
      'launch.invalid_supply',
      `totalSupply has ${fraction.length} decimal places but the token has ${input.decimals}. Scaling it would discard ` +
        `the remainder, and the discarded part would never exist.`,
    );
  }
  if (BigInt(whole) > MAX_WHOLE_SUPPLY) {
    throw new TokenParamsError(
      'launch.supply_out_of_range',
      `totalSupply must be at most ${MAX_WHOLE_SUPPLY} whole tokens. Beyond that the amount is not representable in ` +
        `numeric(38,18), so the token could never be listed, quoted or reconciled on the Fiat Plane.`,
    );
  }

  const scaled = parseUnits(input.totalSupply, input.decimals);
  if (scaled === 0n) {
    throw new TokenParamsError(
      'launch.invalid_supply',
      `totalSupply scales to zero at ${input.decimals} decimals. A token with no supply has no holders and no market.`,
    );
  }

  /**
   * Validated and NORMALISED to its checksummed form, here, once.
   *
   * The normalisation is not cosmetic. `computeTokenAddress` checksums the
   * recipient before hashing it into the init code, while the calldata builder
   * encodes whatever string it was handed — so without this, derivation and
   * calldata are two different spellings of one address travelling separately.
   * They agree today because ABI encoding is case-insensitive, and that is
   * exactly the kind of agreement that stops being true quietly.
   *
   * `isAddress(..., { strict: false })` accepts a mixed-case address whose
   * checksum is wrong, and `toChecksum` then repairs it. That is deliberate:
   * refusing a valid 20-byte address over its capitalisation would reject a
   * correct launch, while the checksum's actual job — catching a typo — is not
   * something this layer can do better than the wallet that will sign.
   */
  if (!isAddress(input.recipient, { strict: false })) {
    throw new TokenParamsError('launch.invalid_recipient', `recipient is not a 20-byte EVM address: ${input.recipient}`);
  }
  const recipient = toChecksum(input.recipient);

  if (/^0x0{40}$/i.test(recipient)) {
    throw new TokenParamsError(
      'launch.invalid_recipient',
      `recipient is the zero address. The entire supply is minted to it at construction, so this would burn the whole ` +
        `supply at the moment of creation.`,
    );
  }

  return { name, symbol, decimals: input.decimals, totalSupply: scaled, recipient };
}
