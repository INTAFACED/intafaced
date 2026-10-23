/**
 * The tabs of one customer's record and its address rules. Kept apart from the reads (record.ts) so the browser gets these
 * constants without the desk catalogue.
 */

export const CUSTOMER_TABS = ['money', 'trade', 'pay', 'cards', 'documents', 'tickets'] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

export const TAB_LABELS: Readonly<Record<CustomerTab, string>> = {
  money: 'Money',
  trade: 'Trade',
  pay: 'Pay',
  cards: 'Cards',
  documents: 'Documents',
  tickets: 'Tickets',
};

/** The code a block with no source carries, so a refusal can be told apart from a read that was never possible. */
export const RECORD_SOURCE_UNWIRED = 'ops.customer_record_source_unwired';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account id, lower-cased, or null when it is not an account id (nothing is read for it). The path segment arrives already
 * decoded by Next.js, so it is not decoded again: a double-encoded address is refused, not read.
 */
export function customerId(raw: string): string | null {
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

/** The tab from `?tab=`, money when none is given; null for a tab that does not exist. */
export function customerTab(raw: string | string[] | undefined): CustomerTab | null {
  if (raw === undefined) return 'money';
  return typeof raw === 'string' && (CUSTOMER_TABS as readonly string[]).includes(raw) ? (raw as CustomerTab) : null;
}

/**
 * The risk card (OPS-rules-monitoring-11, J-ops-console-02 #4). A risk level comes from scoring an account against a risk
 * ruleset on svc-pay's risk scale (OPS-rules-monitoring-02). No service holds a ruleset or a scale, so no account has a
 * risk level: the card says so on every record and never shows a made-up score, band or colour.
 */
export const RISK_CARD = {
  title: 'No risk level',
  reason:
    'No risk ruleset exists: svc-pay holds no risk rulesets or risk scale (OPS-rules-monitoring-02), so no account can be scored. When one is published, this card shows the level and the rules behind it.',
} as const;

/** J-ops-console-02 #4: the KPI indicator strip says "not set" while no indicator is configured (OPS-rules-monitoring-11). */
export const INDICATOR_STRIP = {
  title: 'Not set',
  reason:
    'No account indicators are configured: identity has no indicator configuration and no per-account metrics read (identity.accounts.metrics), so this strip has nothing to measure. When indicators are configured, each one shows here with its value.',
  code: 'compliance.indicators_unset',
} as const;
