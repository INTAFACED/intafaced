/**
 * Words and numbers for the new CRM screens. Pure functions, no React.
 *
 * Money is only ever handled as the exact decimal strings the server sends. Nothing here passes an amount through
 * Number, so a figure of any length keeps every digit. Currencies are never converted into each other.
 */

const upperFirst = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** "family_office" becomes "Family office". The fallback for any value without its own wording. */
export const sentence = (value: string) => upperFirst(value.replace(/_/g, ' ').trim());
/** "indicativeContribution" becomes "Indicative contribution". */
export const labelOfKey = (key: string) => sentence(key.replace(/([A-Z])/g, ' $1').toLowerCase());

export const AUDIENCE_LABEL: Record<string, string> = {
  investor: 'Investor',
  trader: 'Trader',
  merchant: 'Merchant',
  academy: 'Academy',
  partner: 'Partner',
};
export const audienceLabel = (audience: string) => AUDIENCE_LABEL[audience] ?? sentence(audience);

export const STAGE_LABEL: Record<string, string> = {
  new: 'New',
  qualified: 'Qualified',
  diligence: 'Diligence',
  terms: 'Terms',
  invited: 'Invited',
  onboarding: 'Onboarding',
  closed: 'Closed',
};
export const stageLabel = (stage: string) => STAGE_LABEL[stage] ?? sentence(stage);

/** The stages each audience moves through, in order. Mirrors the contract's investor and community stage lists. */
export function stagesFor(audience: string): string[] {
  if (audience === 'investor') return ['new', 'qualified', 'diligence', 'terms', 'closed'];
  return ['new', 'qualified', 'invited', 'onboarding', 'closed'];
}

/** Every enum a questionnaire can hold, in plain words (fix G7: no raw `snake_case` and no half-reworded values). */
const ENUM_WORDS: Record<string, Record<string, string>> = {
  investorType: { individual: 'Individual', family_office: 'Family office', fund: 'Fund', strategic: 'Strategic investor', other: 'Other' },
  participation: { direct: 'Direct', introduction: 'Introductions only', both: 'Direct and introductions' },
  decisionRole: { decision_maker: 'Decision maker', adviser: 'Adviser', introducer: 'Introducer', other: 'Other' },
  timing: { as_available: 'As available', within_three_months: 'Within 3 months', later: 'Later', undecided: 'Undecided' },
  markets: { spot: 'Spot', derivatives: 'Derivatives', copy_trading: 'Copy trading', algorithmic: 'Algorithmic', other: 'Other' },
  experience: { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' },
  role: { individual: 'Individual trader', professional: 'Professional trader', community: 'Community leader' },
  services: { payment_acceptance: 'Payment acceptance', settlement: 'Settlement', payouts: 'Payouts', other: 'Other' },
  format: { self_paced: 'Self-paced', live: 'Live', cohort: 'Cohort', no_preference: 'No preference' },
  relationship: { collaboration: 'Collaboration', partnership: 'Partnership', undecided: 'Undecided' },
};
/** Short forms for the dense list rows. */
const TIMING_SHORT: Record<string, string> = {
  as_available: 'As available',
  within_three_months: '≤ 3 months',
  later: 'Later',
  undecided: 'Undecided',
};
const PERIOD_WORDS: Record<string, string> = { daily: 'a day', monthly: 'a month', annual: 'a year' };

export const humanEnum = (key: string, value: string): string => ENUM_WORDS[key]?.[value] ?? sentence(value);
export const timingShort = (value: string) => TIMING_SHORT[value] ?? sentence(value);

let regionNames: Intl.DisplayNames | null | undefined;
/** "SG" becomes "Singapore"; anything the browser cannot name stays as the code. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en-GB'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/* ------------------------------------------------------------------ exact decimals */

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/;
export const isDecimal = (value: string) => DECIMAL.test(value);

function split(value: string): { whole: string; fraction: string } {
  const match = DECIMAL.exec(value);
  return { whole: match?.[1] ?? '0', fraction: match?.[2] ?? '' };
}
const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** "250000.50" becomes "250,000.5"; trailing zeros after the point are not shown. A value that is not a decimal is returned unchanged. */
export function groupedDecimal(value: string): string {
  if (!isDecimal(value)) return value;
  const { whole, fraction } = split(value);
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${groupDigits(whole)}.${trimmed}` : groupDigits(whole);
}

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
/** "€250,000", "$50,000", or "CHF 1,200" for a currency without a short symbol. Exact digits, never rounded. */
export function formatMoney(amount: string, currency: string): string {
  const number = groupedDecimal(amount);
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${number}` : `${currency} ${number}`;
}

/**
 * A shorter form for tight rows: "€250k", "€12.5M". It is only used when it loses nothing (the amount is a whole number of
 * thousands, or of hundred-thousands of millions); otherwise the full figure is shown. So no digit is ever rounded away.
 */
export function formatMoneyCompact(amount: string, currency: string): string {
  const { whole, fraction } = split(amount);
  if (/[1-9]/.test(fraction) || !isDecimal(amount)) return formatMoney(amount, currency);
  const symbol = SYMBOLS[currency];
  const wrap = (text: string) => (symbol ? `${symbol}${text}` : `${currency} ${text}`);
  if (whole.length >= 7) {
    // Millions, only when the amount is a whole number of hundred-thousands, so nothing is rounded away.
    if (!/0{5}$/.test(whole)) return formatMoney(amount, currency);
    const tenth = whole.slice(-6, -5);
    return wrap(`${groupDigits(whole.slice(0, -6))}${tenth !== '0' ? `.${tenth}` : ''}M`);
  }
  if (whole.length >= 4 && /00$/.test(whole)) {
    const tenth = whole.slice(-3, -2);
    return wrap(`${groupDigits(whole.slice(0, -3))}${tenth !== '0' ? `.${tenth}` : ''}k`);
  }
  return formatMoney(amount, currency);
}

/** Exact sum of two non-negative decimal strings. */
export function addDecimal(a: string, b: string): string {
  const left = split(a);
  const right = split(b);
  const width = Math.max(left.fraction.length, right.fraction.length);
  const scale = BigInt(`1${'0'.repeat(width)}`);
  const toScaled = (part: { whole: string; fraction: string }) =>
    BigInt(part.whole) * scale + BigInt(part.fraction.padEnd(width, '0') || '0');
  const total = toScaled(left) + toScaled(right);
  const whole = total / scale;
  const fraction = width ? (total % scale).toString().padStart(width, '0').replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * `part` as a share of `whole` in tenths of a percent (so 8.2% is 82), rounded down and never above 1000. Exact integer
 * arithmetic on the decimal strings. Zero when `whole` is zero.
 */
export function shareTenths(part: string, whole: string): number {
  const p = split(part);
  const w = split(whole);
  const width = Math.max(p.fraction.length, w.fraction.length);
  const scale = BigInt(`1${'0'.repeat(width)}`);
  const scaled = (x: { whole: string; fraction: string }) => BigInt(x.whole) * scale + BigInt(x.fraction.padEnd(width, '0') || '0');
  const denominator = scaled(w);
  if (denominator === 0n) return 0;
  const tenths = (scaled(p) * 1000n) / denominator;
  return Number(tenths > 1000n ? 1000n : tenths);
}
/** 82 becomes "8.2%". */
export const tenthsText = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}%`;

/** Reads what a founder typed into an amount box ("250,000", "1 200.50") as an exact decimal string, or null when it is not one. */
export function parseTypedAmount(typed: string): string | null {
  const cleaned = typed.replace(/[\s,_]/g, '');
  return isDecimal(cleaned) && /[1-9]/.test(cleaned) ? cleaned : null;
}

/** "€150,000 a month" for a merchant's stated processing volume. */
export function volumeText(volume: { amount: string; currency: string; period: string }): string {
  return `${formatMoney(volume.amount, volume.currency)} ${PERIOD_WORDS[volume.period] ?? volume.period}`;
}
