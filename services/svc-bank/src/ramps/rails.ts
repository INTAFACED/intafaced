import { BankError } from '../errors.js';

/**
 * THE RAMP RAIL PORT (§8.1 `bank.ramps` / D-S-09) — and the line this file draws.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CRYPTO LEDGER HALF vs FIAT §13 SOCKET
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ADR `docs/adr/2026-08-04-bank-vertical-law.md` splits `bank.ramps`:
 *
 *   CRYPTO LEG — buildable today. `crypto-native` already exists as a real rail
 *   in svc-pay; this service adds the bank-facing ledger surface (deposit /
 *   withdraw recipes into the book). No third-party signature is required for
 *   that arithmetic.
 *
 *   FIAT LEG — `socket.psp-partners` commercially. Kind fiat refuses
 *   `bank.fiat_ramp_socket` before any row or ledger post. Never a bank-local
 *   PSP client. A live pay rail id is not a stored fiat row and is not a
 *   ledger post from this service.
 *
 * The setting below selects the CRYPTO ledger half only. There is no value that
 * turns on a fiat rail, and there is no value that claims a live chain send —
 * `simulated` is always true on this surface. Pointing working code at real
 * money is Class X (Nitro human). Live inbound chain confirmation stays in
 * svc-pay so this service does not become a second book against the same
 * chain mirror.
 *
 * Rail label on ledger posts is `bank-crypto-ledger`, deliberately DISTINCT
 * from svc-pay's `crypto-native` boundary: an operator credit here must not
 * desync pay's chain reconciliation (see svc-pay user-money doctrine).
 */

/** What the ramp programme calls itself, and whether it is real. */
export interface RampProgramme {
  /** Stable identifier — also selects the ledger rail when crypto-ledger. */
  readonly id: string;
  /**
   * TRUE MEANS NO LIVE RAMP EXISTS.
   *
   * Literal `true` — cannot be omitted and cannot be flipped to live on this
   * surface. Crypto live send/confirm is svc-pay + Class X. Kind fiat refuses
   * `bank.fiat_ramp_socket` before any row or ledger post (not inventable here).
   */
  readonly simulated: true;
  /** Human label. Never a PSP or partner brand (§0.7). */
  readonly displayName: string;
  /** Ledger rail string used on deposit/withdraw recipes, or null when none. */
  readonly cryptoRail: string | null;
  /** Always names the fiat socket — never "coming soon". */
  readonly fiatLeg: 'socket.psp-partners';
  /**
   * Names the svc-pay RailAdapter plane. Kind fiat refuses
   * `bank.fiat_ramp_socket` before any row or ledger post. Never a bank-local
   * PSP client. This field does not store a fiat row and does not post.
   */
  readonly fiatVia: 'svc-pay.RailAdapter';
}

export const RAMP_SETTINGS = ['none', 'crypto-ledger'] as const;
export type RampSetting = (typeof RAMP_SETTINGS)[number];

/** Ledger rail for the crypto half. Not svc-pay's `crypto-native` boundary. */
export const BANK_CRYPTO_LEDGER_RAIL = 'bank-crypto-ledger';

export const NO_RAMP_PROGRAMME: RampProgramme = {
  id: 'none',
  simulated: true,
  displayName: 'No bank ramp programme',
  cryptoRail: null,
  fiatLeg: 'socket.psp-partners',
  fiatVia: 'svc-pay.RailAdapter',
};

export const CRYPTO_LEDGER_PROGRAMME: RampProgramme = {
  id: 'crypto-ledger',
  simulated: true,
  displayName: 'Crypto ledger half (no chain broadcast; fiat via pay adapters / socket)',
  cryptoRail: BANK_CRYPTO_LEDGER_RAIL,
  fiatLeg: 'socket.psp-partners',
  fiatVia: 'svc-pay.RailAdapter',
};

/**
 * Total mapping. Silence → none. No fallback to crypto-ledger by accident —
 * same posture as `cardIssuerFor` / `BANK_CARD_ISSUER`.
 */
export function rampProgrammeFor(setting: RampSetting): RampProgramme {
  switch (setting) {
    case 'none':
      return NO_RAMP_PROGRAMME;
    case 'crypto-ledger':
      return CRYPTO_LEDGER_PROGRAMME;
    default: {
      const _exhaustive: never = setting;
      throw new Error(`unreachable ramp setting: ${String(_exhaustive)}`);
    }
  }
}

/** Refuse when this deployment has not chosen a crypto ledger half. */
export function assertCryptoRamp(programme: RampProgramme): string {
  if (!programme.cryptoRail) {
    throw new BankError(
      'No bank ramp programme is configured — set BANK_RAMP_MODE=crypto-ledger for the crypto ledger half, or leave none and do not call ramps',
      'bank.no_ramp_rail',
    );
  }
  return programme.cryptoRail;
}

/**
 * Fiat without a live pay RailAdapter. Prefer `resolvePayFiatRailId` so the
 * refusal names what was considered; this helper stays for call sites that
 * have already decided the port cannot host the leg.
 */
export function refuseFiatRamp(): never {
  throw new BankError(
    'Fiat on/off ramp is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. ' +
      'Reuse a live svc-pay RailAdapter via PayFiatRampPort; do not invent APY, card BIN, or a bank-local PSP.',
    'bank.fiat_ramp_socket',
  );
}

/**
 * BANK_RAMP_MODE default is `none`. Fiat stays `bank.fiat_ramp_socket` on that
 * programme — an injected live pay adapter must not sneak a default fiat rail.
 */
export function assertFiatSocketWhenNone(programme: RampProgramme): void {
  if (programme.id === 'none' || programme.cryptoRail === null) {
    refuseFiatRamp();
  }
}
