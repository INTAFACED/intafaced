/**
 * The subscriber desk (SP-status-04): who is subscribed to status updates and in which state, how each channel leaves
 * this deployment, the delivery rows of one published notice (one per subscriber and channel), the two subscribe
 * safeguards (owner values on the status page) and founder imports. Pure and browser safe.
 */
import type { Part } from '@/lib/desk/part';

export const SUBSCRIBER_STATES = ['unconfirmed', 'active', 'unsubscribed'] as const;
export type SubscriberState = (typeof SUBSCRIBER_STATES)[number];
export type DeliveryStatus = 'pending' | 'accepted' | 'failed' | 'refused';
export const IMPORT_MAX = 500;
export const IMPORT_SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Channels {
  readonly email: { readonly sender: 'gateway' | 'local-outbox' | null; readonly notConnected: 'vendor.email' | null };
  readonly sms: string;
  readonly push: string;
}

export interface SubscriberRow {
  readonly id: string;
  readonly email: string;
  readonly state: SubscriberState;
  readonly componentIds: readonly string[] | null;
  readonly source: string | null;
  readonly webhook: boolean;
  readonly createdAt: string;
  readonly deliveries: Readonly<Record<DeliveryStatus, number>>;
}

export interface DeliveryRow {
  readonly key: string;
  readonly email: string;
  readonly channel: 'email' | 'webhook';
  readonly status: DeliveryStatus;
  readonly refusalCode: string | null;
  readonly attempts: number;
}

/** One notice's rows, at most svc-notify's page of them; `more` when the notice has rows beyond those shown. */
export interface EventDeliveries {
  readonly rows: readonly DeliveryRow[];
  readonly more: boolean;
}

export interface PublishedNotice {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly publishedAt: string | null;
}

export interface Safeguards {
  readonly challengeBits: number | null;
  readonly subscribeRatePerHour: number | null;
  readonly revision: number;
}

export interface ImportResult {
  readonly received: number;
  readonly distinct: number;
  readonly added: number;
  readonly alreadyKnown: number;
  readonly invalid: readonly string[];
  readonly limited: number;
}

export interface SubscriberDeskView {
  readonly channels: Part<Channels>;
  readonly subscribers: Part<readonly SubscriberRow[]>;
  readonly state: SubscriberState | null;
  readonly notices: Part<readonly PublishedNotice[]>;
  /** The notice whose delivery rows are shown, or null. */
  readonly noticeId: string | null;
  readonly deliveries: Part<EventDeliveries> | null;
  readonly safeguards: Part<Safeguards>;
  readonly asOf: string;
}

export type SubscriberDeskReply =
  | { readonly ok: true; readonly what: string; readonly imported?: ImportResult }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isInt = (v: unknown): v is number => Number.isInteger(v);
const STATUSES: readonly unknown[] = ['pending', 'accepted', 'failed', 'refused'];

export function readChannels(raw: unknown): Channels | null {
  if (!isRecord(raw) || !isRecord(raw.email) || typeof raw.sms !== 'string' || typeof raw.push !== 'string') return null;
  const { sender, notConnected } = raw.email;
  if (sender !== null && sender !== 'gateway' && sender !== 'local-outbox') return null;
  if (notConnected !== null && notConnected !== 'vendor.email') return null;
  return { email: { sender, notConnected }, sms: raw.sms, push: raw.push };
}

export function readSubscribers(raw: unknown): SubscriberRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SubscriberRow[] = [];
  for (const r of raw) {
    if (
      !isRecord(r) ||
      typeof r.id !== 'string' ||
      typeof r.email !== 'string' ||
      !(SUBSCRIBER_STATES as readonly unknown[]).includes(r.state) ||
      !(r.componentIds === null || (Array.isArray(r.componentIds) && r.componentIds.every((c) => typeof c === 'string'))) ||
      !(r.source === null || typeof r.source === 'string') ||
      typeof r.webhook !== 'boolean' ||
      typeof r.createdAt !== 'string' ||
      !isRecord(r.deliveries) ||
      !STATUSES.every((s) => isInt((r.deliveries as Record<string, unknown>)[s as string]))
    )
      return null;
    const d = r.deliveries as Record<DeliveryStatus, number>;
    out.push({
      id: r.id,
      email: r.email,
      state: r.state as SubscriberState,
      componentIds: r.componentIds as string[] | null,
      source: r.source,
      webhook: r.webhook,
      createdAt: r.createdAt,
      deliveries: { pending: d.pending, accepted: d.accepted, failed: d.failed, refused: d.refused },
    });
  }
  return out;
}

export function readDeliveryRows(raw: unknown): DeliveryRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeliveryRow[] = [];
  for (const r of raw) {
    if (
      !isRecord(r) ||
      typeof r.key !== 'string' ||
      typeof r.email !== 'string' ||
      (r.channel !== 'email' && r.channel !== 'webhook') ||
      !STATUSES.includes(r.status) ||
      !(r.refusalCode === null || typeof r.refusalCode === 'string') ||
      !isInt(r.attempts)
    )
      return null;
    out.push({
      key: r.key,
      email: r.email,
      channel: r.channel,
      status: r.status as DeliveryStatus,
      refusalCode: r.refusalCode,
      attempts: r.attempts,
    });
  }
  return out;
}

export function readEventDeliveries(raw: unknown): EventDeliveries | null {
  if (!isRecord(raw) || typeof raw.more !== 'boolean') return null;
  const rows = readDeliveryRows(raw.rows);
  return rows ? { rows, more: raw.more } : null;
}

export function readPublishedNotices(raw: unknown): PublishedNotice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PublishedNotice[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.title !== 'string') return null;
    if (!(r.publishedAt === null || typeof r.publishedAt === 'string')) return null;
    out.push({ id: r.id, kind: r.kind, title: r.title, publishedAt: r.publishedAt });
  }
  return out;
}

export function readImportResult(raw: unknown): ImportResult | null {
  if (!isRecord(raw)) return null;
  const { received, distinct, added, alreadyKnown, invalid, limited } = raw;
  if (![received, distinct, added, alreadyKnown, limited].every(isInt)) return null;
  if (!Array.isArray(invalid) || !invalid.every((x) => typeof x === 'string')) return null;
  return {
    received: received as number,
    distinct: distinct as number,
    added: added as number,
    alreadyKnown: alreadyKnown as number,
    invalid,
    limited: limited as number,
  };
}

/** The addresses in pasted text: one per line or separated by commas, blanks dropped. */
export function addressesIn(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** What an import of this text would hold before it is sent: duplicates in any letter case count once. */
export function importPreview(text: string): { lines: number; distinct: number } {
  const lines = addressesIn(text);
  return { lines: lines.length, distinct: new Set(lines.map((s) => s.toLowerCase())).size };
}

/** A safeguard value as typed: blank is null (and refuses subscribing), else a whole number in its bounds. */
export function safeguardValue(text: string, min: number, max: number): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= min && n <= max ? { ok: true, value: n } : { ok: false };
}
