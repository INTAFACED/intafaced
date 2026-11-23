/**
 * A short, readable stand-in for a long identifier. Customers can quote it to support; the full value stays behind a
 * "Details" disclosure, in a tooltip or in a copy button, never in body copy.
 */
export function shortReference(id: string): string {
  return id
    .replace(/[^0-9a-z]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}

/**
 * A host no customer can reach: a reserved test name (`.invalid`, `.test`, `.example`, `localhost`), the loopback
 * address or a documentation range (192.0.2.x, 198.51.100.x, 203.0.113.x). A test stack's stand-in address is one of
 * these; a room never offers one to copy or to trust, and says the address is not published instead.
 */
export function isPlaceholderAddress(value: string): boolean {
  const host = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return (
    host === 'localhost' ||
    /\.(invalid|test|example|localhost)$/.test(host) ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]'
  );
}

/** What no customer reads: each kind with the pattern that finds it in a room's text. */
const RAW_TEXT: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'a raw id (a UUID)', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'an internal code (service.reason_code)', pattern: /\b[a-z][a-z0-9]*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: 'a placeholder host', pattern: /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.invalid\b/gi },
  { kind: 'a loopback or documentation address', pattern: /\b(?:127\.0\.0\.1|(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3})\b/g },
];

/** The raw ids, internal codes and placeholder addresses in `text`, in the order they appear. */
export function rawTextIn(text: string): string[] {
  const found: { at: number; value: string }[] = [];
  for (const { pattern } of RAW_TEXT) for (const m of text.matchAll(pattern)) found.push({ at: m.index ?? 0, value: m[0] });
  return found.sort((a, b) => a.at - b.at).map((f) => f.value);
}

/**
 * The Bank refusal codes a journey's step words have the customer read ("refused with the reason `bank.currency_in_use`"),
 * each with the step that names it.
 */
const BANK_CODES_NAMED_BY_STEPS: Readonly<Record<string, string>> = {
  'bank.account_terms_unset': 'J-bank-01 #2: "terms not published" with the refusal code',
  'bank.currency_in_use': 'J-bank-01 #3',
  'bank.onramp_quote_expired': 'J-bank-02 #4: `quote_expired`',
  'bank.space_locked': 'J-bank-07 #2',
  'bank.space_forbidden': 'J-bank-07 #6',
  'bank.below_minimum': 'J-bank-08 #3',
  'bank.card_not_eligible': 'J-bank-13 #1',
  'bank.statement_too_large': 'J-bank-16 (Money)',
  'bank.business_role_forbidden': 'J-bank-19 #1',
  'bank.business_invite_expired': 'J-bank-19 #3',
  'bank.cap_reached': 'J-bank-25 #3',
  'bank.cap_unset': 'J-bank-25 #3',
  'bank.cardholder_unverified': 'J-bank-26 #2',
  'bank.pool_closed': 'J-bank-28 #2',
  'bank.card_spend_assets_unset': 'J-bank-29 #1',
  'bank.card_insufficient_funds': 'J-bank-29 #5',
  'bank.account_details_currencies_unset': 'J-bank-30 #1',
  'bank.direct_deposit_name_mismatch': 'J-bank-30 #6',
  'bank.card_atm_fee_unset': 'J-bank-32 (Money) and #3',
  'bank.global_quote_expired': 'J-pay-12 #3',
  'bank.personal_transfer_terms_unset': 'J-pay-21 #1',
  'bank.protection_pot_empty': 'J-pay-17 (Money)',
  'bank.refund_in_flight': 'J-pay-15 #3',
  'bank.send_review_expired': 'J-pay-20 #5',
  'bank.settle_plan_stale': 'J-pay-07 #6',
  'bank.fx_rate_unset': 'J-portfolio-06 #4',
  'bank.deposit_custody_unset': 'J-wallet-02 #1',
  'bank.global_travel_rule_incomplete': 'J-ops-console-17 #1',
  'bank.global_travel_rule_undecided': 'J-ops-console-17 #1',
};

/**
 * The code a refusal shows after its words, or null when it shows none. A Bank refusal (`bank.*`) ends in plain words:
 * its code stays on the element's `data-code`, unless a step's words name it. A rail or vendor notice (`rail.bank`)
 * keeps its code in the page, as the notice's step words say; other services' codes are left as they are.
 */
export function shownCode(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code.startsWith('bank.') && !(code in BANK_CODES_NAMED_BY_STEPS)) return null;
  return code;
}

/** `words`, then the refusal's code line (`line(code)`) when the page shows that code (`shownCode`). */
export function withCode(words: string, code: string | null | undefined, line: (code: string) => string): string {
  const shown = shownCode(code);
  return shown ? `${words} ${line(shown)}` : words;
}
