/**
 * OPS-alerts-02 routing, silences and contact points.
 * A blank contact, wait, secret or silence end refuses. Nothing here picks a number or a destination.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { OpsAlertContact, OpsAlertMatcher, OpsAlertPolicyInput, OpsAlertSilence } from '@intafaced/contracts';
import {
  OPS_ALERT_CHANNEL_KEY_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_ALERT_ROUTE_INVALID,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_CHANNEL_SECRET_UNSET,
  OPS_ACTIVE_TIME_UNSET,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_GROUP_TIMING_UNSET,
  OPS_MATCHER_INVALID,
  OPS_MUTE_TIMING_UNSET,
  OPS_SILENCE_END_UNSET,
  VENDOR_EMAIL,
  VENDOR_PUSH,
  VENDOR_SMS,
} from '@intafaced/contracts';
import { OpsError } from '../codes.js';

const SLUG = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL = /^[a-z][a-z0-9_]{0,62}$/;
const WILD = /^[a-zA-Z0-9_.*-]{1,80}$/;
const KEY_ENV = 'OPS_ALERT_CHANNEL_KEY';

export const CHANNEL_KINDS = ['email', 'sms', 'push', 'webhook', 'chat', 'paging'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface Timing {
  readonly groupBy: string[] | null;
  readonly groupWaitSeconds: number | null;
  readonly groupIntervalSeconds: number | null;
  readonly repeatSeconds: number | null;
  readonly flapSeconds: number | null;
}

/** Mute timing or the active window. Blank parts are refused; nothing here fills a day, a clock or a zone. */
export interface NoticeWindow {
  readonly days: number[];
  readonly months: number[];
  readonly years: number[];
  readonly start: string;
  readonly end: string;
  readonly location: string;
}

export interface PolicyNode {
  readonly id: string;
  readonly matchers: OpsAlertMatcher[];
  readonly contactId: string | null;
  readonly continue: boolean;
  readonly timing: Timing | null;
  readonly children: PolicyNode[];
}

export interface RouteBody {
  readonly defaultContactId: string;
  readonly timing: Timing;
  readonly mute: NoticeWindow | null;
  readonly active: NoticeWindow | null;
  readonly policies: PolicyNode[];
}

export interface RouteTree extends RouteBody {
  readonly version: number;
  readonly actor: string;
  readonly reason: string;
  readonly updatedAt: string;
}

export interface StoredIntegration {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly address: string | null;
  readonly url: string | null;
  readonly secret: string | null;
  readonly basicUser: string | null;
  readonly basicPassword: string | null;
  readonly bearer: string | null;
}

export interface ContactBody {
  readonly id: string;
  readonly name: string;
  readonly integrations: readonly StoredIntegration[];
}

export interface ResolveHit {
  readonly contacts: string[];
  readonly policyIds: string[];
  readonly timing: Timing;
  /** Deepest match, or the default contact when nothing matches. */
  readonly primaryContact: string;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
type WindowCode = typeof OPS_MUTE_TIMING_UNSET | typeof OPS_ACTIVE_TIME_UNSET;

export function notificationId(contactId: string, ordinal: number): string {
  return `ops:notify:${contactId}:${ordinal}`;
}

export function policyEventKey(version: number): string {
  return `ops:alert-policy:${version}`;
}

function slug(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    throw new OpsError(OPS_ALERT_ROUTE_INVALID, `${field} must be a short lowercase id. Nothing was saved.`);
  }
  return value;
}

function optionalPositive(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OpsError(OPS_GROUP_TIMING_UNSET, `${field} is blank or zero. No interval is invented, and nothing was saved.`);
  }
  return value;
}

function flapOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OpsError(
      OPS_FLAP_SUPPRESSION_UNSET,
      'Flapping suppression is blank or zero. No duration is invented, and nothing was saved.',
    );
  }
  return value;
}

function groupByOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new OpsError(OPS_GROUP_TIMING_UNSET, 'groupBy is blank. No label list is invented, and nothing was saved.');
  }
  return value.map((label) => {
    if (typeof label !== 'string' || !LABEL.test(label)) {
      throw new OpsError(OPS_MATCHER_INVALID, 'A group-by label is not a label name. Nothing was saved.');
    }
    return label;
  });
}

export function timingOf(input: {
  readonly groupBy?: readonly string[] | null;
  readonly groupWaitSeconds?: number | null;
  readonly groupIntervalSeconds?: number | null;
  readonly repeatSeconds?: number | null;
  readonly flapSeconds?: number | null;
}): Timing {
  return {
    groupBy: groupByOf(input.groupBy),
    groupWaitSeconds: optionalPositive(input.groupWaitSeconds, 'groupWaitSeconds'),
    groupIntervalSeconds: optionalPositive(input.groupIntervalSeconds, 'groupIntervalSeconds'),
    repeatSeconds: optionalPositive(input.repeatSeconds, 'repeatSeconds'),
    flapSeconds: flapOf(input.flapSeconds),
  };
}

/** A stored route may predate a field. Missing stays blank; it is not filled in. */
export function timingStored(timing: Partial<Timing> | null | undefined): Timing {
  return {
    groupBy: timing?.groupBy ?? null,
    groupWaitSeconds: timing?.groupWaitSeconds ?? null,
    groupIntervalSeconds: timing?.groupIntervalSeconds ?? null,
    repeatSeconds: timing?.repeatSeconds ?? null,
    flapSeconds: timing?.flapSeconds ?? null,
  };
}

/** Group by, wait, interval and repeat. A blank flap refuses on its own and is not filled in here. */
export function timingReady(timing: Timing): boolean {
  return (
    timing.groupBy !== null &&
    timing.groupBy.length > 0 &&
    timing.groupWaitSeconds !== null &&
    timing.groupWaitSeconds > 0 &&
    timing.groupIntervalSeconds !== null &&
    timing.groupIntervalSeconds > 0 &&
    timing.repeatSeconds !== null &&
    timing.repeatSeconds > 0
  );
}

export function parseMatchers(raw: unknown): OpsAlertMatcher[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new OpsError(OPS_MATCHER_INVALID, 'A policy needs at least one matcher. Nothing was saved.');
  }
  return raw.map((item) => {
    const row = item as Partial<OpsAlertMatcher>;
    if (typeof row.label !== 'string' || !LABEL.test(row.label)) {
      throw new OpsError(OPS_MATCHER_INVALID, 'A matcher label is not a label name. Nothing was saved.');
    }
    if (row.op !== 'eq' && row.op !== 'neq' && row.op !== 'match' && row.op !== 'nmatch') {
      throw new OpsError(OPS_MATCHER_INVALID, 'A matcher is eq, neq, match or nmatch. Nothing was saved.');
    }
    if (typeof row.value !== 'string' || row.value.length === 0 || row.value.length > 200) {
      throw new OpsError(OPS_MATCHER_INVALID, 'A matcher value is blank. Nothing was saved.');
    }
    if ((row.op === 'match' || row.op === 'nmatch') && !WILD.test(row.value)) {
      throw new OpsError(OPS_MATCHER_INVALID, 'A match value may only use letters, digits and *. Nothing was saved.');
    }
    return { label: row.label, op: row.op, value: row.value };
  });
}

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value.slice(0, 200));
}

export function matchersHold(matchers: readonly OpsAlertMatcher[], labels: Readonly<Record<string, string>>): boolean {
  return matchers.every((matcher) => {
    const has = Object.prototype.hasOwnProperty.call(labels, matcher.label);
    const value = has ? (labels[matcher.label] ?? '') : '';
    if (matcher.op === 'eq') return has && value === matcher.value;
    if (matcher.op === 'neq') return !has || value !== matcher.value;
    if (matcher.op === 'match') return has && wildcard(matcher.value, value);
    return !has || !wildcard(matcher.value, value);
  });
}

function parsePolicies(raw: readonly OpsAlertPolicyInput[] | undefined, depth: number, ids: Set<string>): PolicyNode[] {
  if (depth > 8) throw new OpsError(OPS_ALERT_ROUTE_INVALID, 'A routing tree is deeper than 8. Nothing was saved.');
  const nodes = raw ?? [];
  if (nodes.length > 50) throw new OpsError(OPS_ALERT_ROUTE_INVALID, 'A routing level has more than 50 policies. Nothing was saved.');
  return nodes.map((node) => {
    const id = slug(node.id, 'policy id');
    if (ids.has(id)) throw new OpsError(OPS_ALERT_ROUTE_INVALID, `Policy ${id} is listed twice. Nothing was saved.`);
    ids.add(id);
    if (node.continue === undefined) {
      throw new OpsError(OPS_ALERT_ROUTE_INVALID, `Policy ${id} does not say whether matching continues. Nothing was saved.`);
    }
    const inherit = node.inheritTiming !== false;
    const contact =
      node.contactId === undefined || node.contactId === null || node.contactId === '' ? null : slug(node.contactId, 'contact');
    return {
      id,
      matchers: parseMatchers(node.matchers),
      contactId: contact,
      continue: node.continue,
      timing: inherit ? null : timingOf(node),
      children: parsePolicies(node.children, depth + 1, ids),
    };
  });
}

function clockMinute(value: string): number | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function numberList(value: unknown, min: number, max: number, code: WindowCode, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
    throw new OpsError(code, `${label} is blank. No window is invented, and nothing was saved.`);
  }
  return value.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) {
      throw new OpsError(code, `${label} is blank. No window is invented, and nothing was saved.`);
    }
    return item;
  });
}

/** Omitted is blank. A present window must name every part; a zero-length range is blank. */
export function parseNoticeWindow(value: unknown, code: WindowCode): NoticeWindow | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new OpsError(code, 'The time window is blank. No window is invented, and nothing was saved.');
  const row = value as { days?: unknown; months?: unknown; years?: unknown; start?: unknown; end?: unknown; location?: unknown };
  const days = numberList(row.days, 1, 31, code, 'The days');
  const months = numberList(row.months, 1, 12, code, 'The months');
  const years = numberList(row.years, 1970, 9999, code, 'The years');
  if (typeof row.start !== 'string' || typeof row.end !== 'string') {
    throw new OpsError(code, 'The time range is blank. No duration is invented, and nothing was saved.');
  }
  const start = clockMinute(row.start);
  const end = clockMinute(row.end);
  if (start === null || end === null || start === end) {
    throw new OpsError(code, 'The time range is blank or zero. No duration is invented, and nothing was saved.');
  }
  const location = typeof row.location === 'string' ? row.location.trim() : '';
  if (!location) throw new OpsError(code, 'The location is blank. No time zone is invented, and nothing was saved.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: location }).format(0);
  } catch {
    throw new OpsError(code, 'The location is not a time zone. No time zone is invented, and nothing was saved.');
  }
  return { days, months, years, start: row.start, end: row.end, location };
}

function zonedMinute(iso: string, timeZone: string): { year: number; month: number; day: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), minute: hour * 60 + Number(parts.minute) };
}

/** True when the owner's window contains `now` in the owner's zone. A broken zone refuses; it does not become UTC. */
export function windowCovers(window: NoticeWindow, nowIso: string, code: WindowCode): boolean {
  let parts: { year: number; month: number; day: number; minute: number };
  try {
    parts = zonedMinute(nowIso, window.location);
  } catch {
    throw new OpsError(code, 'The location is not a time zone. No time zone is invented, and nothing was sent.');
  }
  if (!window.years.includes(parts.year) || !window.months.includes(parts.month) || !window.days.includes(parts.day)) return false;
  const start = clockMinute(window.start);
  const end = clockMinute(window.end);
  if (start === null || end === null || start === end) return false;
  if (start < end) return parts.minute >= start && parts.minute < end;
  return parts.minute >= start || parts.minute < end;
}

export type GroupSuppression =
  { readonly kind: 'silence'; readonly id: string } | { readonly kind: 'mute' } | { readonly kind: 'inactive' };

export type GroupDecision =
  | { readonly outcome: 'refused'; readonly code: string }
  | { readonly outcome: 'suppressed'; readonly suppressed: GroupSuppression }
  | { readonly outcome: 'send' };

/**
 * Timing first, then an active silence, then flap and the two windows.
 * A matching silence stores a suppression and does not deliver. Evaluation is not this function's job.
 */
export function groupDecision(input: {
  readonly timing: Timing;
  readonly mute: NoticeWindow | null;
  readonly active: NoticeWindow | null;
  readonly silenceId: string | null;
  readonly now: string;
}): GroupDecision {
  const timing = timingStored(input.timing);
  if (!timingReady(timing)) return { outcome: 'refused', code: OPS_GROUP_TIMING_UNSET };
  if (input.silenceId) return { outcome: 'suppressed', suppressed: { kind: 'silence', id: input.silenceId } };
  if (timing.flapSeconds === null || timing.flapSeconds <= 0) return { outcome: 'refused', code: OPS_FLAP_SUPPRESSION_UNSET };
  if (!input.mute) return { outcome: 'refused', code: OPS_MUTE_TIMING_UNSET };
  if (!input.active) return { outcome: 'refused', code: OPS_ACTIVE_TIME_UNSET };
  if (windowCovers(input.mute, input.now, OPS_MUTE_TIMING_UNSET)) return { outcome: 'suppressed', suppressed: { kind: 'mute' } };
  if (!windowCovers(input.active, input.now, OPS_ACTIVE_TIME_UNSET)) {
    return { outcome: 'suppressed', suppressed: { kind: 'inactive' } };
  }
  return { outcome: 'send' };
}

export function parseRoute(input: {
  readonly defaultContactId?: string;
  readonly groupBy?: readonly string[] | null;
  readonly groupWaitSeconds?: number | null;
  readonly groupIntervalSeconds?: number | null;
  readonly repeatSeconds?: number | null;
  readonly flapSeconds?: number | null;
  readonly mute?: unknown;
  readonly active?: unknown;
  readonly policies?: readonly OpsAlertPolicyInput[];
}): RouteBody {
  const contact = input.defaultContactId?.trim() ?? '';
  if (!SLUG.test(contact)) {
    throw new OpsError(OPS_ALERT_DEFAULT_CONTACT_UNSET, 'The default contact is blank. The routing tree was not saved.');
  }
  return {
    defaultContactId: contact,
    timing: timingOf(input),
    mute: parseNoticeWindow(input.mute, OPS_MUTE_TIMING_UNSET),
    active: parseNoticeWindow(input.active, OPS_ACTIVE_TIME_UNSET),
    policies: parsePolicies(input.policies, 1, new Set()),
  };
}

export function contactIdsOf(body: RouteBody): string[] {
  const ids = new Set<string>([body.defaultContactId]);
  const walk = (nodes: readonly PolicyNode[]): void => {
    for (const node of nodes) {
      if (node.contactId) ids.add(node.contactId);
      walk(node.children);
    }
  };
  walk(body.policies);
  return [...ids];
}

export function routeMentions(body: RouteBody | null, contactId: string): boolean {
  if (!body) return false;
  return contactIdsOf(body).includes(contactId);
}

interface Hit {
  readonly contactId: string;
  readonly policyId: string;
  readonly depth: number;
  readonly timing: Timing | null;
}

function walk(
  nodes: readonly PolicyNode[],
  labels: Readonly<Record<string, string>>,
  inherited: string,
  depth: number,
  hits: Hit[],
  stop: { done: boolean },
): void {
  for (const node of nodes) {
    if (stop.done) return;
    if (!matchersHold(node.matchers, labels)) continue;
    hits.push({ contactId: node.contactId ?? inherited, policyId: node.id, depth, timing: node.timing });
    walk(node.children, labels, node.contactId ?? inherited, depth + 1, hits, stop);
    if (!node.continue) {
      stop.done = true;
      return;
    }
  }
}

/** No matching policy uses the default contact. A continue flag keeps earlier matches as well as the deepest one. */
export function resolveRoute(tree: RouteBody, labels: Readonly<Record<string, string>>): ResolveHit {
  const hits: Hit[] = [];
  const stop = { done: false };
  walk(tree.policies, labels, tree.defaultContactId, 1, hits, stop);
  if (hits.length === 0) {
    return { contacts: [tree.defaultContactId], policyIds: [], timing: tree.timing, primaryContact: tree.defaultContactId };
  }
  const deepest = hits.reduce((best, hit) => (hit.depth >= best.depth ? hit : best));
  const timing = deepest.timing ?? tree.timing;
  const contacts = [...new Set(hits.map((hit) => hit.contactId))];
  return { contacts, policyIds: hits.map((hit) => hit.policyId), timing, primaryContact: deepest.contactId };
}

export function sealSecret(plain: string): string {
  const key = process.env[KEY_ENV]?.trim() ?? '';
  if (!key) {
    throw new OpsError(OPS_ALERT_CHANNEL_KEY_UNSET, 'OPS_ALERT_CHANNEL_KEY is blank. A channel secret was not stored.');
  }
  const raw = createHash('sha256').update(key).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', raw, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

export function openSecret(sealed: string): string {
  const key = process.env[KEY_ENV]?.trim() ?? '';
  if (!key) throw new OpsError(OPS_ALERT_CHANNEL_KEY_UNSET, 'OPS_ALERT_CHANNEL_KEY is blank. A stored channel secret cannot be read.');
  const parts = sealed.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new OpsError(OPS_CHANNEL_SECRET_UNSET, 'A stored channel secret is not readable. Nothing was sent.');
  }
  const raw = createHash('sha256').update(key).digest();
  const decipher = createDecipheriv('aes-256-gcm', raw, Buffer.from(parts[2] ?? '', 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[3] ?? '', 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[4] ?? '', 'base64url')), decipher.final()]).toString('utf8');
}

function httpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel URL is not a URL. Nothing was saved.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel URL is not http or https. Nothing was saved.');
  }
  if (url.username || url.password) {
    throw new OpsError(OPS_CHANNEL_AUTH_CONFLICT, 'Put auth in one header, not in the URL. Nothing was saved.');
  }
  return url.toString();
}

function textOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new OpsError(OPS_ALERT_ROUTE_INVALID, 'A channel field is not text. Nothing was saved.');
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parseIntegrations(raw: unknown, previous: readonly StoredIntegration[]): StoredIntegration[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'A contact point needs one to eight integrations. Nothing was saved.');
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    const row = item as {
      id?: unknown;
      kind?: unknown;
      address?: unknown;
      url?: unknown;
      secret?: unknown;
      basicUser?: unknown;
      basicPassword?: unknown;
      bearer?: unknown;
    };
    const id = slug(row.id, 'integration id');
    if (seen.has(id)) throw new OpsError(OPS_ALERT_ROUTE_INVALID, `Integration ${id} is listed twice. Nothing was saved.`);
    seen.add(id);
    if (!CHANNEL_KINDS.includes(row.kind as ChannelKind)) {
      throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'A channel is email, sms, push, webhook, chat or paging. Nothing was saved.');
    }
    const kind = row.kind as ChannelKind;
    const prior = previous.find((integration) => integration.id === id && integration.kind === kind);
    const address = textOrNull(row.address);
    const url = textOrNull(row.url);
    const basicUser = textOrNull(row.basicUser);
    const basicPasswordIn = textOrNull(row.basicPassword);
    const bearerIn = textOrNull(row.bearer);
    const secretIn = textOrNull(row.secret);
    if (basicPasswordIn && bearerIn) {
      throw new OpsError(OPS_CHANNEL_AUTH_CONFLICT, 'Basic auth and a bearer header are both set. Nothing was saved.');
    }
    const secret = secretIn ? sealSecret(secretIn) : (prior?.secret ?? null);
    // Setting one auth drops the other. A blank field does not clear a stored secret.
    const basicPassword = bearerIn ? null : basicPasswordIn ? sealSecret(basicPasswordIn) : (prior?.basicPassword ?? null);
    const bearer = basicPasswordIn ? null : bearerIn ? sealSecret(bearerIn) : (prior?.bearer ?? null);
    const basicUserOut = bearerIn ? null : (basicUser ?? prior?.basicUser ?? null);
    if ((basicPassword && bearer) || (basicUserOut && bearer)) {
      throw new OpsError(OPS_CHANNEL_AUTH_CONFLICT, 'Basic auth and a bearer header are both set. Nothing was saved.');
    }
    if ((kind === 'email' || kind === 'sms') && !address) {
      throw new OpsError(OPS_CHANNEL_TARGET_UNSET, `The ${kind} address is blank. Nothing was saved.`);
    }
    if (kind === 'push' && !secret) throw new OpsError(OPS_CHANNEL_SECRET_UNSET, 'The push token is blank. Nothing was saved.');
    if (kind === 'webhook' || kind === 'chat' || kind === 'paging') {
      if (!url) throw new OpsError(OPS_CHANNEL_TARGET_UNSET, `The ${kind} URL is blank. Nothing was saved.`);
      if (!secret) throw new OpsError(OPS_CHANNEL_SECRET_UNSET, `The ${kind} secret is blank. Nothing was saved.`);
    }
    return {
      id,
      kind,
      address,
      url: url ? httpUrl(url) : null,
      secret,
      basicUser: basicUserOut,
      basicPassword,
      bearer,
    };
  });
}

export function maskIntegration(row: StoredIntegration): OpsAlertContact['integrations'][number] {
  return {
    id: row.id,
    kind: row.kind,
    address: row.address,
    url: row.url,
    secret: row.secret ? '********' : null,
    basicUser: row.basicUser,
    basicPassword: row.basicPassword ? '********' : null,
    bearer: row.bearer ? '********' : null,
  };
}

export function maskContact(
  row: ContactBody & { version: number; retiredAt: string | null; actor: string; reason: string; updatedAt: string },
): OpsAlertContact {
  return { ...row, integrations: row.integrations.map(maskIntegration) };
}

export function vendorCode(kind: ChannelKind): typeof VENDOR_EMAIL | typeof VENDOR_SMS | typeof VENDOR_PUSH | null {
  if (kind === 'email') return VENDOR_EMAIL;
  if (kind === 'sms') return VENDOR_SMS;
  if (kind === 'push') return VENDOR_PUSH;
  return null;
}

export function signWebhook(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function webhookBody(input: {
  readonly notificationId: string;
  readonly contactId: string;
  readonly integrationId: string;
  readonly at: string;
}): string {
  return JSON.stringify({
    notificationId: input.notificationId,
    contactId: input.contactId,
    integrationId: input.integrationId,
    at: input.at,
  });
}

export function parseSilenceEnd(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpsError(OPS_SILENCE_END_UNSET, 'The silence end is blank. Nothing was saved.');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new OpsError(OPS_SILENCE_END_UNSET, 'The silence end is not a time. Nothing was saved.');
  return new Date(parsed).toISOString();
}

export function silenceActive(silence: Pick<OpsAlertSilence, 'endsAt'>, now: string): boolean {
  return Date.parse(silence.endsAt) > Date.parse(now);
}

export function assertAuthExclusive(row: StoredIntegration): void {
  if (row.basicPassword && row.bearer) {
    throw new OpsError(OPS_CHANNEL_AUTH_CONFLICT, 'Basic auth and a bearer header are both set. Nothing was sent.');
  }
  if (row.basicUser && row.bearer) {
    throw new OpsError(OPS_CHANNEL_AUTH_CONFLICT, 'Basic auth and a bearer header are both set. Nothing was sent.');
  }
}
