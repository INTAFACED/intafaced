import type { FounderMerchantSection, FounderMerchantSectionInput } from '@intafaced/contracts';
import type { ChipSpec } from '@/lib/merchants/chips';

/**
 * Pure rules for the founder reads added in #4870 (merchant sections, recent merchants, payout and dispute lists,
 * live counters, risk). Nothing here reads a service, so every rule is a plain test.
 */

export const PAGE_LIMIT = 25;
export type Query = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** First value of a query key, or undefined. Anything over 512 characters is dropped, so a hostile URL never reaches a service. */
export function one(query: Query | undefined, key: string): string | undefined {
  const raw = query?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

export interface SectionSpec {
  readonly section: FounderMerchantSection;
  readonly title: string;
  readonly sub: string;
  /** Statuses the service accepts for this section. Absent: the section has no status filter. */
  readonly statuses?: readonly string[];
  readonly searchable?: boolean;
  /** Short name for the count tile when the title is too long for one. */
  readonly kpiLabel?: string;
}

const PAYOUT_STATES = ['pending', 'posted', 'paid_out', 'failed'] as const;

export const SECTION_SPECS: Readonly<Record<FounderMerchantSection, SectionSpec>> = {
  payments: {
    section: 'payments',
    title: 'Payments',
    sub: 'Every payment this merchant took, with rail and the fee that was applied.',
    statuses: ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'],
    searchable: true,
  },
  refunds: {
    section: 'refunds',
    title: 'Refunds',
    sub: 'Refunds paid back to payers, with the ledger effect recorded for each.',
    statuses: ['posted', 'settled', 'reversed'],
    searchable: true,
  },
  disputes: {
    section: 'disputes',
    title: 'Disputes',
    sub: 'Chargebacks and claims, with the response deadline taken from the rail.',
    statuses: ['open', 'contested', 'accepted', 'won', 'lost'],
    searchable: true,
  },
  settlements: {
    section: 'settlements',
    title: 'Settlements',
    sub: 'Settlement windows with gross, fees and net, and the fee snapshot used.',
    statuses: PAYOUT_STATES,
    searchable: true,
  },
  payouts: {
    section: 'payouts',
    title: 'Settlements credited to the merchant balance',
    kpiLabel: 'Settlements credited',
    sub: 'Each row is a settlement the platform posted to this merchant’s balance. A row here is not money sent out: it is paid out only after the merchant asks for a payout, the approvals pass and the rail confirms it.',
    statuses: PAYOUT_STATES,
    searchable: true,
  },
  destinations: {
    section: 'destinations',
    title: 'Payout destinations',
    sub: 'Where payouts go. Values are masked here and are never unmasked on this page.',
  },
  customers: {
    section: 'customers',
    title: 'Customers',
    sub: 'Opaque customer references with their payment totals per asset.',
    searchable: true,
  },
  links: {
    section: 'links',
    title: 'Payment links',
    sub: 'Links the merchant shares to get paid, and how often each was used.',
    searchable: true,
  },
  invoices: {
    section: 'invoices',
    title: 'Invoices',
    sub: 'Invoices the merchant issued and whether they were paid.',
    statuses: ['draft', 'sent', 'void', 'paid'],
    searchable: true,
  },
  subscriptions: {
    section: 'subscriptions',
    title: 'Subscriptions',
    sub: 'Recurring charges and when each runs next.',
    statuses: ['active', 'paused', 'cancelled', 'completed'],
    searchable: true,
  },
  team: {
    section: 'team',
    title: 'Team',
    sub: 'People who can act for this merchant, and their role.',
    statuses: ['active', 'invited', 'removed'],
    searchable: true,
  },
  apiKeys: { section: 'apiKeys', title: 'API keys', sub: 'Keys the merchant uses to call the API. Secrets are never shown.' },
  webhooks: {
    section: 'webhooks',
    title: 'Webhook endpoints',
    sub: 'Addresses the merchant receives events on, and their health.',
    statuses: ['active', 'disabled'],
    searchable: true,
  },
  deliveries: {
    section: 'deliveries',
    title: 'Webhook deliveries',
    sub: 'Each event sent to an endpoint, with attempts and the last HTTP status.',
    statuses: ['pending', 'delivered', 'failed', 'dead'],
  },
  activity: { section: 'activity', title: 'Activity', sub: 'Merchant-side actions with the person who did them.', searchable: true },
  exports: {
    section: 'exports',
    title: 'Export jobs',
    sub: 'Statement and report exports the merchant requested.',
    statuses: ['queued', 'running', 'ready', 'failed', 'expired'],
    searchable: true,
  },
  profile: { section: 'profile', title: 'Business profile and KYB', sub: 'Current status and the append-only verification history.' },
};

/** Which contract sections each founder drilldown page (by its URL slug) shows. */
export const SCREEN_SECTIONS: Readonly<Record<string, readonly FounderMerchantSection[]>> = {
  payments: ['payments', 'refunds'],
  disputes: ['disputes'],
  settlements: ['settlements'],
  payouts: ['payouts', 'destinations'],
  balances: ['exports'],
  checkout: ['links'],
  billing: ['subscriptions', 'invoices'],
  customers: ['customers'],
  team: ['team'],
  developers: ['apiKeys', 'webhooks', 'deliveries'],
  compliance: ['profile'],
  activity: ['activity'],
  edit: ['profile'],
};

/** The slug is the last segment of a drilldown route such as `/merchants/:id/payments`. */
export const slugOf = (route: string): string => route.slice(route.lastIndexOf('/') + 1);

export const cursorKey = (section: FounderMerchantSection) => `cursor_${section}`;
export const statusKey = (section: FounderMerchantSection) => `status_${section}`;
export const searchKey = (section: FounderMerchantSection) => `q_${section}`;

/** The service call for one section, built only from filters the service accepts for it. */
export function sectionRequest(merchantId: string, section: FounderMerchantSection, query: Query | undefined): FounderMerchantSectionInput {
  const spec = SECTION_SPECS[section];
  const cursor = one(query, cursorKey(section));
  const status = one(query, statusKey(section));
  const search = one(query, searchKey(section))?.trim().slice(0, 200);
  const filters: NonNullable<FounderMerchantSectionInput['filters']> = {
    ...(status && spec.statuses?.includes(status) ? { status } : {}),
    ...(search && spec.searchable ? { search } : {}),
  };
  return {
    merchantId,
    section,
    limit: PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
  };
}

/** A link to the same page with some query keys changed. `undefined` removes a key. Other keys are kept. */
export function hrefWith(path: string, query: Query | undefined, patch: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query ?? {})) {
    if (key in patch) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined && value !== '') params.set(key, value);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

const chip = (label: string, tone: ChipSpec['tone'], hint: string): ChipSpec => ({ label, tone, hint });

/** One status vocabulary for every list on the founder reads. The label always says it; colour is never the only signal. */
const STATUS: Record<string, ChipSpec> = {
  created: chip('created', 'warn', 'Started; nothing authorised yet.'),
  authorized: chip('authorized', 'warn', 'Authorised, not yet captured.'),
  captured: chip('captured', 'live', 'Captured. The money is in.'),
  settled: chip('settled', 'live', 'Settled to the merchant.'),
  refunded: chip('refunded', 'info', 'Refunded to the payer.'),
  disputed: chip('disputed', 'danger', 'Under dispute.'),
  failed: chip('failed', 'danger', 'Did not go through.'),
  posted: chip('posted', 'info', 'Recorded in the ledger and waiting to be paid out.'),
  paid_out: chip('paid out', 'live', 'Paid out to the merchant.'),
  pending: chip('pending', 'warn', 'Waiting for its next step.'),
  reversed: chip('reversed', 'danger', 'Reversed after it was posted.'),
  open: chip('open', 'warn', 'Open. A response may be due.'),
  contested: chip('contested', 'info', 'The merchant contested it. Waiting for the rail.'),
  accepted: chip('accepted', 'dark', 'Liability accepted.'),
  won: chip('won', 'live', 'Decided in the merchant’s favour.'),
  lost: chip('lost', 'danger', 'Decided against the merchant.'),
  draft: chip('draft', 'dark', 'Not sent yet.'),
  sent: chip('sent', 'info', 'Sent to the customer.'),
  void: chip('void', 'dark', 'Cancelled.'),
  paid: chip('paid', 'live', 'Paid.'),
  active: chip('active', 'live', 'In use.'),
  paused: chip('paused', 'warn', 'Paused. Nothing runs until it is resumed.'),
  cancelled: chip('cancelled', 'dark', 'Cancelled.'),
  completed: chip('completed', 'dark', 'Ran to its end.'),
  invited: chip('invited', 'warn', 'Invited, not yet accepted.'),
  removed: chip('removed', 'dark', 'Removed.'),
  disabled: chip('disabled', 'danger', 'Switched off, so no events are sent.'),
  delivered: chip('delivered', 'live', 'The endpoint accepted it.'),
  dead: chip('dead', 'danger', 'Retries are used up. It will not be sent again.'),
  queued: chip('queued', 'warn', 'Waiting to start.'),
  running: chip('running', 'info', 'Being built now.'),
  ready: chip('ready', 'live', 'File is ready.'),
  expired: chip('expired', 'dark', 'File is no longer available.'),
  suspended: chip('suspended', 'danger', 'Payments are stopped.'),
  closed: chip('closed', 'dark', 'Permanently closed.'),
  approved: chip('approved', 'live', 'Approved.'),
  rejected: chip('rejected', 'danger', 'Declined.'),
  none: chip('none', 'dark', 'Nothing submitted.'),
};

/**
 * Settlement status in plain words. `posted` means the ledger credited the merchant's balance; it never means money left.
 * Only `paid_out` means the rail confirmed a payout.
 */
const SETTLEMENT_STATUS: Record<string, ChipSpec> = {
  pending: chip('not credited yet', 'warn', 'The settlement is still being prepared. Nothing is credited to the merchant balance yet.'),
  posted: chip(
    'credited, not sent',
    'info',
    'Credited to the merchant balance. No money has been sent out for it; a payout must be requested, approved and confirmed first.',
  ),
  paid_out: chip('paid out', 'live', 'A payout for this settlement was sent and the rail confirmed it.'),
  failed: chip('failed', 'danger', 'The settlement did not complete. See the failure code.'),
};

export function settlementStatusChip(value: string): ChipSpec {
  return SETTLEMENT_STATUS[value] ?? statusChip(value);
}

/** Sections whose rows are settlements, so their statuses are shown in settlement words. */
export const SETTLEMENT_ROW_SECTIONS: readonly FounderMerchantSection[] = ['payouts', 'settlements'];

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Exact sum of non-negative decimal strings, with no floats. Null when any value is not a plain decimal. */
export function sumDecimals(values: readonly string[]): string | null {
  const parts = values.map((v) => DECIMAL.exec(v));
  if (parts.some((p) => p === null)) return null;
  const scale = Math.max(0, ...parts.map((p) => (p![2] ?? '').length));
  const total = parts.reduce((sum, p) => sum + BigInt(`${p![1]}${(p![2] ?? '').padEnd(scale, '0')}`), 0n);
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export interface PaidOutTotal {
  readonly assetId: string;
  readonly net: string;
  readonly settlements: number;
}

/**
 * What was actually paid out, per asset: the net of settlements the rail confirmed (`paid_out`). Credited, pending and failed
 * settlements are never counted, so a merchant with nothing sent gets an empty list, which the page shows as zero.
 */
export function paidOutTotals(rows: readonly { assetId: string; net: string; status: string }[]): PaidOutTotal[] | null {
  const byAsset = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== 'paid_out') continue;
    byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row.net]);
  }
  const out: PaidOutTotal[] = [];
  for (const [assetId, nets] of [...byAsset].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const net = sumDecimals(nets);
    if (net === null) return null;
    out.push({ assetId, net, settlements: nets.length });
  }
  return out;
}

export function statusChip(value: string): ChipSpec {
  return (
    STATUS[value] ?? {
      label: value.replace(/_/g, ' '),
      tone: 'neutral',
      hint: `This service reported "${value}", which this console has no description for.`,
    }
  );
}

/** Move the decimal point two places right in a decimal-string fraction: "0.4231" becomes "42.31". Strings only; no floats. */
export function shareAsPercent(share: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(share);
  if (!match) return null;
  const whole = match[1]!;
  const frac = (match[2] ?? '').padEnd(2, '0');
  const left = `${whole}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const right = frac.slice(2).replace(/0+$/, '');
  return right ? `${left}.${right}` : left;
}

/** "3 h 5 min" from whole seconds. Null means the queue is empty, which is not an age of zero. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'Nothing waiting';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}

/** Whole-number total of status counts. Counts are integers, so plain addition is exact. */
export const totalOf = (rows: readonly { count: number }[]): number => rows.reduce((sum, row) => sum + row.count, 0);
export const countOf = (rows: readonly { status: string; count: number }[], status: string): number =>
  rows.find((row) => row.status === status)?.count ?? 0;

export type RiskWindowKey = 'today' | '7d' | '30d' | 'all';
export const RISK_WINDOWS: readonly { key: RiskWindowKey; label: string; preset: 'today' | 'rolling_7d' | 'rolling_30d' | null }[] = [
  { key: 'today', label: 'Today', preset: 'today' },
  { key: '7d', label: '7 days', preset: 'rolling_7d' },
  { key: '30d', label: '30 days', preset: 'rolling_30d' },
  { key: 'all', label: 'All projected days', preset: null },
];
export function parseRiskWindow(value: string | undefined): RiskWindowKey {
  return RISK_WINDOWS.find((w) => w.key === value)?.key ?? 'all';
}
export const RISK_TOP_N = 10;
