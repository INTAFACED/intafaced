/**
 * Combo / multi-leg through matching (PTX-M11-R04).
 * A combo without named legs and ratios refuses.
 * A leg name that contains '|' or ';' refuses: those separators are the identity encoding, so a raw join would alias a different leg set.
 * Missing strike, expiry, or ratio on a combo rest refuses.
 * Complete named legs rest and match as one instrument. The engine does not rest two independent options and call it a combo.
 */
import { ZERO, formatAmount, type Amount } from '@intafaced/ledger-client/money';
import type { ComboLeg } from './types.js';

export const COMBO_LEGS_MISSING = 'missing_combo_legs' as const;
export const RATIO_MISSING = 'missing_ratio' as const;
export const STRIKE_MISSING = 'missing_strike' as const;
export const EXPIRY_MISSING = 'missing_expiry' as const;
export const COMBO_UNSUPPORTED = 'combo_unsupported' as const;
export const COMBO_DISAGREES = 'combo_disagrees' as const;

export type ComboRefuse =
  | typeof COMBO_LEGS_MISSING
  | typeof RATIO_MISSING
  | typeof STRIKE_MISSING
  | typeof EXPIRY_MISSING
  | typeof COMBO_UNSUPPORTED
  | typeof COMBO_DISAGREES;

export function wantsCombo(order: { readonly combo?: boolean | null; readonly legs?: readonly ComboLeg[] | null }): boolean {
  return order.combo === true || order.legs !== undefined;
}

/** Caller ratio. Null/zero is missing — never invented. Negative is a short leg. */
export function readRatio(leg: { readonly ratio?: Amount | null }): Amount | null {
  if (leg.ratio === undefined || leg.ratio === null || leg.ratio === ZERO) return null;
  return leg.ratio;
}

/** Caller strike. Null/zero is missing — never invented from last, mid, best, or mark. */
export function readStrike(leg: { readonly strike?: Amount | null }): Amount | null {
  if (leg.strike === undefined || leg.strike === null || leg.strike <= ZERO) return null;
  return leg.strike;
}

/** Caller expiry. Null/blank is missing — never invented. */
export function readExpiry(leg: { readonly expiry?: string | null }): string | null {
  if (leg.expiry === undefined || leg.expiry === null) return null;
  const expiry = leg.expiry.trim();
  if (expiry.length === 0) return null;
  return expiry;
}

export function comboLegsRefuse(
  legs: readonly ComboLeg[] | null | undefined,
): { readonly code: typeof COMBO_LEGS_MISSING; readonly message: string } | null {
  if (legs == null || legs.length < 2) {
    return {
      code: COMBO_LEGS_MISSING,
      message: 'a combo requires named legs; the engine does not invent a combo book',
    };
  }
  const seen = new Set<string>();
  for (const [index, leg] of legs.entries()) {
    const name = leg.name?.trim() ?? '';
    if (name.length === 0 || splitsComboIdentity(name)) {
      return {
        code: COMBO_LEGS_MISSING,
        message:
          name.length === 0
            ? `combo leg ${index} is unnamed; the engine does not invent a combo book`
            : `combo leg ${index} name contains an identity separator; the engine does not alias a different leg set`,
      };
    }
    if (seen.has(name)) {
      return {
        code: COMBO_LEGS_MISSING,
        message: `combo leg ${name} is duplicated; the engine does not silently merge legs`,
      };
    }
    seen.add(name);
  }
  return null;
}

export function ratioRefuse(ratio: Amount | null): { readonly code: typeof RATIO_MISSING; readonly message: string } | null {
  if (ratio !== null) return null;
  return {
    code: RATIO_MISSING,
    message: 'a combo leg requires a ratio; the engine does not invent a combo book',
  };
}

export function comboStrikeRefuse(strike: Amount | null): { readonly code: typeof STRIKE_MISSING; readonly message: string } | null {
  if (strike !== null) return null;
  return {
    code: STRIKE_MISSING,
    message: 'a combo leg requires a strike; the engine does not invent a strike',
  };
}

export function comboExpiryRefuse(expiry: string | null): { readonly code: typeof EXPIRY_MISSING; readonly message: string } | null {
  if (expiry !== null) return null;
  return {
    code: EXPIRY_MISSING,
    message: 'a combo leg requires an expiry; the engine does not invent an expiry',
  };
}

/** '|' separates fields and ';' separates legs. Either one inside a field aliases another leg set. */
function splitsComboIdentity(value: string): boolean {
  return value.includes('|') || value.includes(';');
}

type ComboIdentityRefusal = {
  readonly code: typeof COMBO_LEGS_MISSING | typeof RATIO_MISSING | typeof STRIKE_MISSING | typeof EXPIRY_MISSING;
  readonly message: string;
};

export function comboUnsupportedRefuse(): {
  readonly code: typeof COMBO_UNSUPPORTED;
  readonly message: string;
} {
  return {
    code: COMBO_UNSUPPORTED,
    message: 'a combo is not a matching book; the engine does not rest independent option legs',
  };
}

export function comboDisagreesRefuse(): {
  readonly code: typeof COMBO_DISAGREES;
  readonly message: string;
} {
  return {
    code: COMBO_DISAGREES,
    message: 'a combo takes a resting combo with the same named legs and ratios; the engine does not invent a match',
  };
}

/** One instrument from named legs + ratios + strike + expiry. Leg order does not mint a second book. */
export function comboIdentity(legs: readonly ComboLeg[]): string | ComboIdentityRefusal {
  const parts: string[] = [];
  for (const [index, leg] of legs.entries()) {
    const name = (leg.name ?? '').trim();
    if (name.length === 0 || splitsComboIdentity(name)) {
      return {
        code: COMBO_LEGS_MISSING,
        message:
          name.length === 0
            ? `combo leg ${index} is unnamed; the engine does not invent a combo book`
            : `combo leg ${index} name contains an identity separator; the engine does not alias a different leg set`,
      };
    }
    const ratio = readRatio(leg);
    if (ratio === null) {
      return (
        ratioRefuse(ratio) ?? {
          code: RATIO_MISSING,
          message: 'a combo leg requires a ratio; the engine does not invent a combo book',
        }
      );
    }
    const strike = readStrike(leg);
    if (strike === null) {
      return (
        comboStrikeRefuse(strike) ?? {
          code: STRIKE_MISSING,
          message: 'a combo leg requires a strike; the engine does not invent a strike',
        }
      );
    }
    const expiry = readExpiry(leg);
    if (expiry === null) {
      return (
        comboExpiryRefuse(expiry) ?? {
          code: EXPIRY_MISSING,
          message: 'a combo leg requires an expiry; the engine does not invent an expiry',
        }
      );
    }
    const ratioText = formatAmount(ratio);
    const strikeText = formatAmount(strike);
    if (splitsComboIdentity(ratioText) || splitsComboIdentity(strikeText) || splitsComboIdentity(expiry)) {
      return {
        code: COMBO_LEGS_MISSING,
        message: `combo leg ${index} contains an identity separator; the engine does not alias a different leg set`,
      };
    }
    parts.push(`${name}|${ratioText}|${strikeText}|${expiry}`);
  }
  return parts.sort().join(';');
}

export function comboIntentRefuse(order: {
  readonly combo?: boolean | null;
  readonly legs?: readonly ComboLeg[] | null;
}): { readonly code: ComboRefuse; readonly message: string } | null {
  if (!wantsCombo(order)) return null;
  const missingLegs = comboLegsRefuse(order.legs);
  if (missingLegs) return missingLegs;
  for (const leg of order.legs as readonly ComboLeg[]) {
    const missingRatio = ratioRefuse(readRatio(leg));
    if (missingRatio) return missingRatio;
    const missingStrike = comboStrikeRefuse(readStrike(leg));
    if (missingStrike) return missingStrike;
    const missingExpiry = comboExpiryRefuse(readExpiry(leg));
    if (missingExpiry) return missingExpiry;
  }
  const identity = comboIdentity(order.legs as readonly ComboLeg[]);
  if (typeof identity !== 'string') return identity;
  return null;
}
