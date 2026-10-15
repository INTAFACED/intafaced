import { parseAmount, displayAmount } from '../../../shared/money';
import type { AssetAmount, Freshness, Invitation, Member, MemberRole, MerchantRecord, Series, Snapshot, TeamRole } from './schemas';

/**
 * Pure helpers for the merchant portal. Money here is only ever compared or formatted: amounts are decimal
 * strings, comparisons go through scaled bigint (`parseAmount`), and no amount becomes a JS number. The one
 * exception is a bar height, which is a ratio of two amounts used for geometry, never shown as money.
 */

/** A projection older than this is called stale on screen. A display rule only; it moves no money. */
export const STALE_AFTER_SECONDS = 300;

export const DAY_MS = 86_400_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));

/** The window the 30-day chart asks for: whole UTC days, today included (end is exclusive). */
export function seriesWindow(now: Date, days = 30): { from: string; to: string } {
  const today = utcDay(now);
  return { from: `${addDays(today, -(days - 1))}T00:00:00.000Z`, to: `${addDays(today, 1)}T00:00:00.000Z` };
}

export type Staleness = { kind: 'unknown' } | { kind: 'fresh'; lagSeconds: number } | { kind: 'stale'; lagSeconds: number };
export function staleness(freshness: Freshness): Staleness {
  if (freshness.asOf === null || freshness.lagSeconds === null) return { kind: 'unknown' };
  return freshness.lagSeconds > STALE_AFTER_SECONDS
    ? { kind: 'stale', lagSeconds: freshness.lagSeconds }
    : { kind: 'fresh', lagSeconds: freshness.lagSeconds };
}
/** `{ n, unit }` so the copy layer can pluralise; lag is a duration, not money. */
export function lagParts(seconds: number): { n: number; unit: 'seconds' | 'minutes' | 'hours' } {
  if (seconds < 60) return { n: seconds, unit: 'seconds' };
  if (seconds < 3600) return { n: Math.floor(seconds / 60), unit: 'minutes' };
  return { n: Math.floor(seconds / 3600), unit: 'hours' };
}

export function isZeroAmount(value: string): boolean {
  return parseAmount(value) === 0n;
}
/** Amounts of one asset as `1,234.50`; an empty list is "nothing yet", never a made-up zero. */
export function amountFor(list: readonly AssetAmount[], assetCode: string): string | null {
  return list.find((entry) => entry.assetCode === assetCode)?.amount ?? null;
}
export function assetsOf(snapshot: Snapshot): string[] {
  const all = new Set<string>();
  for (const list of [
    snapshot.captured,
    snapshot.refunded,
    snapshot.net,
    snapshot.averagePayment,
    snapshot.largestPayment,
    snapshot.feeRevenue,
  ])
    for (const entry of list) all.add(entry.assetCode);
  for (const row of snapshot.balances) all.add(row.assetCode);
  for (const row of snapshot.settlements) all.add(row.assetCode);
  return [...all].sort();
}
export const hasActivity = (snapshot: Snapshot) =>
  snapshot.paymentCount > 0 ||
  snapshot.captured.length > 0 ||
  snapshot.balances.some((b) => !isZeroAmount(b.available) || !isZeroAmount(b.clearing));
export function formatMoney(value: string, assetCode: string): string {
  return `${displayAmount(value)} ${assetCode}`;
}

export type Bar = { day: string; volume: string; pct: number; today: boolean };
/** One bar per UTC day for one asset, zero-filled so a quiet day is visible; heights are bigint ratios. */
export function bars(series: Series, assetCode: string, days: number, todayDay: string): Bar[] {
  const byDay = new Map<string, string>();
  for (const point of series.points) if (point.assetCode === assetCode) byDay.set(point.day, point.volume);
  const rows = Array.from({ length: days }, (_, i) => addDays(todayDay, -(days - 1 - i))).map((day) => ({
    day,
    volume: byDay.get(day) ?? '0',
  }));
  const max = rows.reduce((m, r) => (parseAmount(r.volume) > m ? parseAmount(r.volume) : m), 0n);
  return rows.map((r) => ({
    ...r,
    today: r.day === todayDay,
    pct: max === 0n ? 0 : Number((parseAmount(r.volume) * 1000n) / max) / 10,
  }));
}
export const seriesAssets = (series: Series) => [...new Set(series.points.map((p) => p.assetCode))].sort();

/** Share of payments in each status, as whole-number percentages that are only used to size a bar. */
export function mixShares(mix: Snapshot['statusMix']): Array<{ status: string; count: number; pct: number }> {
  const total = mix.reduce((n, row) => n + row.count, 0);
  return mix.filter((row) => row.count > 0).map((row) => ({ ...row, pct: total === 0 ? 0 : Math.round((row.count / total) * 100) }));
}

// ---- onboarding -----------------------------------------------------------------------------------------

export type StepState = 'todo' | 'current' | 'done' | 'waiting';
export type Steps = {
  business: StepState;
  verification: StepState;
  payout: StepState;
  current: 0 | 1 | 2;
  sandboxReady: boolean;
  liveWaiting: boolean;
};
/**
 * Progress comes from the service, never from the browser: a merchant record means step 1 is done, a KYB
 * status past `none` means step 2 has been submitted. A payout destination cannot be read back (the service
 * publishes no read), so step 3 is only "done" for what this visit just saved.
 */
export function onboardingSteps(merchant: MerchantRecord | null, kybStatus: string | null, destinationSaved: boolean): Steps {
  const business: StepState = merchant ? 'done' : 'current';
  const kyb = kybStatus ?? merchant?.kybStatus ?? 'none';
  const verification: StepState = !merchant ? 'todo' : kyb === 'approved' ? 'done' : kyb === 'pending' ? 'waiting' : 'current';
  const payout: StepState = !merchant ? 'todo' : destinationSaved ? 'done' : verification === 'current' ? 'todo' : 'current';
  const current = !merchant ? 0 : verification === 'current' || verification === 'waiting' ? 1 : 2;
  return {
    business,
    verification,
    payout,
    current: current as 0 | 1 | 2,
    sandboxReady: Boolean(merchant) && destinationSaved,
    liveWaiting: Boolean(merchant) && kyb !== 'approved',
  };
}

export type BusinessForm = {
  legalName: string;
  /** Optional trading name. Left blank, the service shows the legal name. */
  displayName: string;
  country: string;
  businessType: string;
  website: string;
  contactEmail: string;
  expectedVolume: string;
};
export const emptyBusiness: BusinessForm = {
  legalName: '',
  displayName: '',
  country: '',
  businessType: '',
  website: '',
  contactEmail: '',
  expectedVolume: '',
};
export type BusinessErrors = Partial<Record<keyof BusinessForm, 'required' | 'country' | 'website' | 'email' | 'volume' | 'name'>>;
/** The service refuses a name over 120 characters or holding a control or invisible formatting character (not U+200D); say so before sending. Same class as the service and database. */
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const BAD_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const nameProblem = (value: string) => [...value.trim()].length > 120 || BAD_NAME.test(value.trim());
export function validateBusiness(form: BusinessForm): BusinessErrors {
  const errors: BusinessErrors = {};
  if (form.legalName.trim().length < 2) errors.legalName = 'required';
  else if (nameProblem(form.legalName)) errors.legalName = 'name';
  if (nameProblem(form.displayName)) errors.displayName = 'name';
  if (!/^[A-Za-z]{2}$/.test(form.country.trim())) errors.country = 'country';
  if (form.businessType.trim().length < 2) errors.businessType = 'required';
  if (form.website.trim()) {
    try {
      const url = new URL(form.website.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.website = 'website';
    } catch {
      errors.website = 'website';
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())) errors.contactEmail = 'email';
  // Declared volume is free text for a person to read ("about 40 payments a month"); a number is not required.
  if (form.expectedVolume.length > 200) errors.expectedVolume = 'volume';
  return errors;
}
export function businessDetails(form: BusinessForm): Record<string, string> {
  return {
    legalName: form.legalName.trim(),
    country: form.country.trim().toUpperCase(),
    businessType: form.businessType.trim(),
    ...(form.website.trim() ? { website: form.website.trim() } : {}),
    contactEmail: form.contactEmail.trim(),
    ...(form.expectedVolume.trim() ? { declaredExpectedVolume: form.expectedVolume.trim() } : {}),
  };
}

/** The two names the service stores on the merchant. The display name is sent only when the person typed one. */
export function merchantNames(form: BusinessForm): { legalName: string; displayName?: string } {
  return {
    legalName: form.legalName.trim(),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
  };
}

/** Shape checks the service repeats: a crypto destination is an EVM address; a bank one is an IBAN or IFSC. */
export function destinationShapeOk(kind: 'crypto' | 'bank', ref: string): boolean {
  const value = ref.trim();
  if (kind === 'crypto') return /^0x[0-9a-fA-F]{40}$/.test(value);
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact)) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact) || compact.length < 15 || compact.length > 34) return false;
  let remainder = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}
export const railKind = (railId: string): 'crypto' | 'bank' => (railId.startsWith('crypto') ? 'crypto' : 'bank');

// ---- team ----------------------------------------------------------------------------------------------

export const memberActions = (me: MemberRole | null, member: Member) => {
  const manage = me === 'owner' || me === 'admin';
  const self = member.role === 'owner';
  const adminTarget = member.role === 'admin' && me !== 'owner';
  const canChange = manage && !self && member.status === 'active' && !adminTarget;
  return { canChange, canRemove: canChange, reason: !manage ? 'role' : self ? 'owner' : adminTarget ? 'admin' : null } as const;
};
/** Roles this person may hand out: only the owner may grant admin. */
export const grantableRoles = (me: MemberRole | null): readonly TeamRole[] =>
  me === 'owner' ? ['admin', 'finance', 'developer', 'viewer'] : me === 'admin' ? ['finance', 'developer', 'viewer'] : [];
export const pendingFor = (invitations: readonly Invitation[]) => invitations.length;

// ---- shared --------------------------------------------------------------------------------------------

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Digits only, at most 18 places, no sign: what the service accepts as a threshold. */
export const isDecimalThreshold = (value: string) => /^\d+(\.\d{1,18})?$/.test(value.trim());

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}
export function nextDueSoonest<T extends { responseDueAt: string | null }>(rows: readonly T[]): T | null {
  const dated = rows.filter((r) => r.responseDueAt !== null).sort((a, b) => Date.parse(a.responseDueAt!) - Date.parse(b.responseDueAt!));
  return dated[0] ?? null;
}
