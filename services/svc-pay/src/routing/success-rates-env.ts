import { readOperatorDeclaredSuccessRate } from '../routing-inputs.js';
import type { RailRoutingProfile } from './decide.js';

/**
 * `PAY_CHECKOUT_SUCCESS_RATES`: the owner's declared success fraction per checkout rail, as
 * `railId:fraction` pairs (`crypto-native:0.97`). Blank declares none, so smart routing refuses every
 * rail with `pay.routing_approval_rate_unset` and the hosted page says the business cannot take
 * payment. A rail with no profile, a repeated rail or a fraction outside (0, 1] fails boot: a typo
 * here must not read as "no rate" and quietly turn checkout off, nor as a rate nobody declared.
 */
export function parseCheckoutSuccessRates(
  raw: string | undefined,
  profiles: readonly RailRoutingProfile[],
): Readonly<Record<string, string>> {
  const rates: Record<string, string> = {};
  for (const entry of (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = entry.lastIndexOf(':');
    const railId = at > 0 ? entry.slice(0, at).trim() : '';
    const fraction = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!railId) throw new Error(`PAY_CHECKOUT_SUCCESS_RATES entry "${entry}" is not railId:fraction`);
    if (!profiles.some((p) => p.railId === railId)) {
      throw new Error(
        `PAY_CHECKOUT_SUCCESS_RATES names "${railId}", which has no routing profile. Profiles: ${profiles.map((p) => p.railId).join(', ')}`,
      );
    }
    if (railId in rates) throw new Error(`PAY_CHECKOUT_SUCCESS_RATES names "${railId}" twice`);
    const read = readOperatorDeclaredSuccessRate(fraction);
    if (!read.ok)
      throw new Error(
        `PAY_CHECKOUT_SUCCESS_RATES gives "${railId}" the fraction "${fraction}"; write a decimal in (0, 1] with a leading 0 or 1 and at most 9 places, such as 0.97`,
      );
    rates[railId] = read.declared;
  }
  return rates;
}

/** The profiles with the declared fractions laid on. A rail the owner did not name keeps no rate. */
export function withSuccessRates(profiles: readonly RailRoutingProfile[], rates: Readonly<Record<string, string>>): RailRoutingProfile[] {
  return profiles.map((p) => (rates[p.railId] === undefined ? { ...p } : { ...p, successRate: rates[p.railId] }));
}
