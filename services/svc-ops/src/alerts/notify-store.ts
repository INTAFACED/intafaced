/**
 * OPS-alerts-02 durable routing desk. Actor, reason and audit commit together.
 * Ids are the caller's slug or ops:notify:<contact>:<n>. No random id is minted.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { OpsAlertContact, OpsAlertPolicyInput, OpsAlertSilence } from '@intafaced/contracts';
import {
  OPS_ALERT_ROUTE_INVALID,
  OPS_ALERT_ROUTE_UNSET,
  OPS_ALERT_ROUTE_VERSION_STALE,
  OPS_CHANNEL_DELIVERY_FAILED,
  OPS_CHANNEL_SECRET_UNSET,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_CONTACT_POINT_IN_USE,
  OPS_CONTACT_POINT_NOT_FOUND,
  OPS_CONTACT_VERSION_STALE,
  OPS_GROUP_TIMING_UNSET,
  OPS_SILENCE_ID_TAKEN,
  VENDOR_EMAIL,
  VENDOR_PUSH,
  VENDOR_SMS,
} from '@intafaced/contracts';
import { OPS_ALERT_ACTOR_UNSET, OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import { fingerprintOf } from './rules.js';
import { assertChannelTarget, pinnedChannelPost } from './channel-target.js';
import {
  assertAuthExclusive,
  contactIdsOf,
  groupDecision,
  maskContact,
  matchersHold,
  notificationId,
  openSecret,
  parseIntegrations,
  parseMatchers,
  parseRoute,
  parseSilenceEnd,
  policyEventKey,
  resolveRoute,
  routeMentions,
  signWebhook,
  timingStored,
  vendorCode,
  webhookBody,
  type ContactBody,
  type GroupSuppression,
  type ResolveHit,
  type RouteBody,
  type RouteTree,
  type StoredIntegration,
} from './notify.js';

export interface ChannelAttempt {
  readonly notificationId: string;
  readonly attempt: number;
  readonly contactId: string;
  readonly integrationId: string;
  readonly code: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface TestResult {
  readonly notificationId: string;
  readonly code: string | null;
  readonly stored: true;
}

export interface GroupResult {
  readonly sent: boolean;
  readonly code: string | null;
  readonly notificationId: string | null;
  readonly suppressed: GroupSuppression | null;
}

export interface RouteSave {
  readonly expectedVersion?: number;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly defaultContactId?: string;
  readonly groupBy?: readonly string[] | null;
  readonly groupWaitSeconds?: number | null;
  readonly groupIntervalSeconds?: number | null;
  readonly repeatSeconds?: number | null;
  readonly flapSeconds?: number | null;
  readonly mute?: unknown;
  readonly active?: unknown;
  readonly policies?: readonly OpsAlertPolicyInput[];
}

export interface ContactSave {
  readonly id?: string;
  readonly name?: string;
  readonly expectedVersion?: number;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly integrations?: unknown;
}

export interface SilenceSave {
  readonly id?: string;
  readonly matchers?: unknown;
  readonly endsAt?: unknown;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface SendInput {
  readonly contactId: string;
  readonly integrationId: string;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface GroupInput {
  readonly ruleId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly key: string;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

export interface AlertNotifyStore {
  getRoute(): Promise<RouteTree | null>;
  saveRoute(input: RouteSave): Promise<RouteTree>;
  resolve(labels: Readonly<Record<string, string>>): Promise<ResolveHit>;
  createSilence(input: SilenceSave): Promise<OpsAlertSilence>;
  getSilence(id: string): Promise<OpsAlertSilence | null>;
  saveContact(input: ContactSave): Promise<OpsAlertContact>;
  getContact(id: string): Promise<OpsAlertContact | null>;
  listContacts(limit: number): Promise<readonly OpsAlertContact[]>;
  retireContact(input: {
    readonly id: string;
    readonly key: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
  }): Promise<OpsAlertContact>;
  testChannel(input: SendInput): Promise<TestResult>;
  groupingSend(input: GroupInput): Promise<GroupResult>;
  attempts(contactId: string, limit: number): Promise<readonly ChannelAttempt[]>;
}

interface LiveContact extends ContactBody {
  readonly version: number;
  readonly retiredAt: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly updatedAt: string;
}

interface AttemptRow extends ChannelAttempt {
  readonly key: string;
  readonly fingerprint: string;
}

const SLUG = /^[a-z][a-z0-9_-]{0,62}$/;
const VENDORS = new Set<string>([VENDOR_EMAIL, VENDOR_SMS, VENDOR_PUSH]);

function actorOf(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed || trimmed.length > 200) throw new OpsError(OPS_ALERT_ACTOR_UNSET, 'The operator id is blank. Nothing was saved.');
  return trimmed;
}

function reasonOf(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500) throw new OpsError(OPS_ALERT_ACTOR_UNSET, 'The reason is blank. Nothing was saved.');
  return trimmed;
}

function conflict(what: string): never {
  throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, `This idempotency key was already used for a different ${what}.`);
}

function slug(value: unknown, blank: string): string {
  if (typeof value !== 'string' || !SLUG.test(value)) throw new OpsError(OPS_ALERT_ROUTE_INVALID, blank);
  return value;
}

function treeOf(body: RouteBody, version: number, actor: string, reason: string, updatedAt: string): RouteTree {
  return { ...body, version, actor, reason, updatedAt };
}

function shown(row: LiveContact): OpsAlertContact {
  return maskContact(row);
}

function routeFingerprint(input: RouteSave): string {
  return fingerprintOf({
    op: 'route',
    expectedVersion: input.expectedVersion ?? null,
    defaultContactId: input.defaultContactId ?? null,
    groupBy: input.groupBy ?? null,
    groupWaitSeconds: input.groupWaitSeconds ?? null,
    groupIntervalSeconds: input.groupIntervalSeconds ?? null,
    repeatSeconds: input.repeatSeconds ?? null,
    flapSeconds: input.flapSeconds ?? null,
    mute: input.mute ?? null,
    active: input.active ?? null,
    policies: input.policies ?? null,
  });
}

function finished(rows: readonly AttemptRow[]): AttemptRow | null {
  return rows.find((row) => row.code === null || VENDORS.has(row.code)) ?? null;
}

interface Delivery {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Everything a POST needs, read before it is sent. A blank target, an unreadable secret, a blank channel key or a
 * refused address is a typed refusal here, never stored as a failed delivery.
 */
function deliveryFor(row: StoredIntegration, body: string): Delivery {
  if (!row.url) throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel has no URL. Nothing was sent.');
  if (!row.secret) throw new OpsError(OPS_CHANNEL_SECRET_UNSET, 'The channel has no signing secret. Nothing was sent.');
  assertChannelTarget(new URL(row.url));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-intafaced-signature': signWebhook(openSecret(row.secret), body),
  };
  if (row.bearer) headers.authorization = `Bearer ${openSecret(row.bearer)}`;
  else if (row.basicPassword) {
    headers.authorization = `Basic ${Buffer.from(`${row.basicUser ?? ''}:${openSecret(row.basicPassword)}`).toString('base64')}`;
  }
  return { url: row.url, headers };
}

/** True when the receiver answered 2xx. A network error, timeout, refused address or other status is false. */
async function post(delivery: Delivery, body: string): Promise<boolean> {
  try {
    return (await pinnedChannelPost(delivery.url, body, delivery.headers, 3_000)).ok;
  } catch {
    return false;
  }
}

export function createMemoryNotify(): AlertNotifyStore {
  let route: RouteTree | null = null;
  const routeKeys = new Map<string, { fingerprint: string; tree: RouteTree }>();
  const contacts = new Map<string, LiveContact>();
  const contactKeys = new Map<string, { fingerprint: string; contact: OpsAlertContact }>();
  const silences = new Map<string, OpsAlertSilence>();
  const silenceKeys = new Map<string, { fingerprint: string; silence: OpsAlertSilence }>();
  const attempts: AttemptRow[] = [];
  const notes: { id: string; contactId: string; integrationId: string; ordinal: number }[] = [];
  const audits: { key: string; fingerprint: string; action: string; after?: unknown }[] = [];
  const claims = new Map<string, { fingerprint: string; promise: Promise<TestResult> }>();

  /** One key names one change across every desk action. */
  const keyFree = (key: string): void => {
    const taken = audits.find((row) => row.key === key);
    if (taken) conflict(taken.action);
  };

  const live = (id: string): LiveContact => {
    const found = contacts.get(id);
    if (!found || found.retiredAt) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such contact point.');
    return found;
  };

  async function send(input: SendInput, action: 'channel.tested' | 'grouping.sent'): Promise<TestResult> {
    const actor = actorOf(input.actor);
    const reason = reasonOf(input.reason);
    const fingerprint = fingerprintOf({ op: action, key: input.key, contactId: input.contactId, integrationId: input.integrationId });
    const rowsFor = (): AttemptRow[] => attempts.filter((row) => row.key === input.key);
    const rows = rowsFor();
    if (rows.some((row) => row.fingerprint !== fingerprint)) conflict('channel test');
    const done = finished(rows);
    if (done) return { notificationId: done.notificationId, code: done.code, stored: true };
    // Recorded before deliver, so the other same-key caller waits and does not POST.
    const claimed = claims.get(input.key);
    if (claimed) {
      if (claimed.fingerprint !== fingerprint) conflict('channel test');
      return claimed.promise;
    }
    let settle!: (value: TestResult) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<TestResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    promise.catch(() => undefined);
    claims.set(input.key, { fingerprint, promise });
    const finish = async (): Promise<TestResult> => {
      const again = rowsFor();
      if (again.some((row) => row.fingerprint !== fingerprint)) conflict('channel test');
      const held = audits.find((row) => row.key === input.key);
      if (held && (held.action !== action || held.fingerprint !== fingerprint)) conflict(held.action);
      const already = finished(again);
      if (already) return { notificationId: already.notificationId, code: already.code, stored: true };
      const contact = live(input.contactId);
      const integration = contact.integrations.find((item) => item.id === input.integrationId);
      if (!integration) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such integration.');
      assertAuthExclusive(integration);
      let id = again[0]?.notificationId;
      if (!id) {
        const ordinal =
          (notes.filter((row) => row.contactId === input.contactId && row.integrationId === input.integrationId).at(-1)?.ordinal ?? 0) + 1;
        id = notificationId(input.contactId, ordinal);
        notes.push({ id, contactId: input.contactId, integrationId: input.integrationId, ordinal });
      }
      const attempt = (again.at(-1)?.attempt ?? 0) + 1;
      const write = (code: string | null): TestResult => {
        attempts.push({
          key: input.key,
          fingerprint,
          notificationId: id,
          attempt,
          contactId: input.contactId,
          integrationId: input.integrationId,
          code,
          actor,
          reason,
          at: input.at,
        });
        if (!audits.some((row) => row.key === input.key)) audits.push({ key: input.key, fingerprint, action });
        return { notificationId: id, code, stored: true };
      };
      const vendor = vendorCode(integration.kind);
      if (vendor) return write(vendor);
      const body = webhookBody({ notificationId: id, contactId: input.contactId, integrationId: input.integrationId, at: input.at });
      const delivery = deliveryFor(integration, body);
      return write((await post(delivery, body)) ? null : OPS_CHANNEL_DELIVERY_FAILED);
    };
    try {
      const result = await finish();
      settle(result);
      return result;
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      claims.delete(input.key);
    }
  }

  return {
    async getRoute() {
      return route;
    },
    async saveRoute(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = routeFingerprint(input);
      const prior = routeKeys.get(input.key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict('routing tree');
        return prior.tree;
      }
      keyFree(input.key);
      const body = parseRoute(input);
      for (const id of contactIdsOf(body)) live(id);
      const current = route?.version;
      if (current !== input.expectedVersion && !(current === undefined && input.expectedVersion === undefined)) {
        throw new OpsError(
          OPS_ALERT_ROUTE_VERSION_STALE,
          current !== undefined
            ? `The routing tree is at version ${current}, not ${input.expectedVersion ?? 'a new tree'}.`
            : 'No routing tree to update.',
        );
      }
      const saved = treeOf(body, (current ?? 0) + 1, actor, reason, input.at);
      route = saved;
      routeKeys.set(input.key, { fingerprint, tree: saved });
      audits.push({ key: input.key, fingerprint, action: 'route.saved' });
      return saved;
    },
    async resolve(labels) {
      if (!route) throw new OpsError(OPS_ALERT_ROUTE_UNSET, 'No routing tree is saved. Nothing was routed.');
      return resolveRoute(route, labels);
    },
    async createSilence(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const id = slug(input.id, 'The silence id is blank. Nothing was saved.');
      const endsAt = parseSilenceEnd(input.endsAt);
      const matchers = parseMatchers(input.matchers);
      const fingerprint = fingerprintOf({ op: 'silence', id, matchers, endsAt });
      const prior = silenceKeys.get(input.key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict('silence');
        return prior.silence;
      }
      keyFree(input.key);
      if (silences.has(id)) throw new OpsError(OPS_SILENCE_ID_TAKEN, 'That silence id is already stored. Nothing was saved.');
      const silence: OpsAlertSilence = { id, matchers, endsAt, actor, reason, createdAt: input.at };
      silences.set(id, silence);
      silenceKeys.set(input.key, { fingerprint, silence });
      audits.push({ key: input.key, fingerprint, action: 'silence.created' });
      return silence;
    },
    async getSilence(id) {
      return silences.get(id) ?? null;
    },
    async saveContact(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = fingerprintOf({
        op: 'contact',
        id: input.id ?? null,
        name: input.name ?? null,
        expectedVersion: input.expectedVersion ?? null,
        integrations: input.integrations ?? null,
      });
      const prior = contactKeys.get(input.key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict('contact point');
        return prior.contact;
      }
      keyFree(input.key);
      const id = slug(input.id, 'The contact id is blank. Nothing was saved.');
      const name = input.name?.trim() ?? '';
      if (!name || name.length > 120) throw new OpsError(OPS_ALERT_ROUTE_INVALID, 'The contact name is blank. Nothing was saved.');
      const current = contacts.get(id) ?? null;
      const currentVersion = current?.version;
      if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
        throw new OpsError(
          OPS_CONTACT_VERSION_STALE,
          currentVersion !== undefined
            ? `The contact is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new contact'}.`
            : 'No such contact to update.',
        );
      }
      const integrations = parseIntegrations(input.integrations, current?.integrations ?? []);
      const saved: LiveContact = {
        id,
        name,
        integrations,
        version: (currentVersion ?? 0) + 1,
        retiredAt: null,
        actor,
        reason,
        updatedAt: input.at,
      };
      contacts.set(id, saved);
      const contact = shown(saved);
      contactKeys.set(input.key, { fingerprint, contact });
      audits.push({ key: input.key, fingerprint, action: 'contact.saved' });
      return contact;
    },
    async getContact(id) {
      const found = contacts.get(id);
      return found ? shown(found) : null;
    },
    async listContacts(limit) {
      return [...contacts.values()]
        .filter((row) => row.retiredAt === null)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(shown);
    },
    async retireContact(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = fingerprintOf({ op: 'retire-contact', id: input.id });
      const prior = contactKeys.get(input.key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict('contact point');
        return prior.contact;
      }
      keyFree(input.key);
      const found = contacts.get(input.id);
      if (!found) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such contact point.');
      if (routeMentions(route, input.id))
        throw new OpsError(OPS_CONTACT_POINT_IN_USE, 'A routing policy uses this contact. It was not retired.');
      const saved: LiveContact = found.retiredAt ? found : { ...found, retiredAt: input.at, actor, reason, updatedAt: input.at };
      contacts.set(input.id, saved);
      const contact = shown(saved);
      contactKeys.set(input.key, { fingerprint, contact });
      if (!found.retiredAt) audits.push({ key: input.key, fingerprint, action: 'contact.retired' });
      return contact;
    },
    testChannel(input) {
      return send(input, 'channel.tested');
    },
    async groupingSend(input) {
      const fingerprint = fingerprintOf({ op: 'group', key: input.key, ruleId: input.ruleId, labels: input.labels });
      const prior = audits.find(
        (row) => row.key === input.key && (row.action === 'grouping.refused' || row.action === 'grouping.suppressed'),
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint) conflict('grouped notice');
        const after = prior.after as { code?: string; suppressed?: GroupSuppression } | undefined;
        if (prior.action === 'grouping.suppressed') {
          return { sent: false, code: null, notificationId: null, suppressed: after?.suppressed ?? null };
        }
        return { sent: false, code: after?.code ?? OPS_GROUP_TIMING_UNSET, notificationId: null, suppressed: null };
      }
      // A key that already reached the send path is not decided again; the send replays or finishes it.
      const sent = attempts.find((row) => row.key === input.key);
      if (sent) {
        const result = await send(
          {
            contactId: sent.contactId,
            integrationId: sent.integrationId,
            key: input.key,
            actor: input.actor,
            reason: input.reason,
            at: input.at,
          },
          'grouping.sent',
        );
        return { sent: result.code === null, code: result.code, notificationId: result.notificationId, suppressed: null };
      }
      keyFree(input.key);
      if (!route) throw new OpsError(OPS_ALERT_ROUTE_UNSET, 'No routing tree is saved. Nothing was sent.');
      const hit = resolveRoute(route, input.labels);
      const silence = [...silences.values()]
        .filter((row) => Date.parse(row.endsAt) > Date.parse(input.at))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .find((row) => matchersHold(row.matchers, input.labels));
      const block = groupDecision({
        timing: timingStored(hit.timing),
        mute: route.mute ?? null,
        active: route.active ?? null,
        silenceId: silence?.id ?? null,
        now: input.at,
      });
      if (block.outcome === 'refused') {
        audits.push({ key: input.key, fingerprint, action: 'grouping.refused', after: { code: block.code } });
        return { sent: false, code: block.code, notificationId: null, suppressed: null };
      }
      if (block.outcome === 'suppressed') {
        audits.push({ key: input.key, fingerprint, action: 'grouping.suppressed', after: { suppressed: block.suppressed } });
        return { sent: false, code: null, notificationId: null, suppressed: block.suppressed };
      }
      const contact = live(hit.primaryContact);
      const integration = contact.integrations[0];
      if (!integration) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'The contact has no integration. Nothing was sent.');
      const result = await send(
        { contactId: contact.id, integrationId: integration.id, key: input.key, actor: input.actor, reason: input.reason, at: input.at },
        'grouping.sent',
      );
      return { sent: result.code === null, code: result.code, notificationId: result.notificationId, suppressed: null };
    },
    async attempts(contactId, limit) {
      return attempts.filter((row) => row.contactId === contactId).slice(-limit);
    },
  };
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

interface RouteRow {
  body: RouteBody;
  version: number;
  actor: string;
  reason: string;
  updated_at: Date;
  fingerprint?: string;
  at?: Date;
}

interface ContactRow {
  contact_id: string;
  name: string;
  integrations: StoredIntegration[];
  version: number;
  retired_at: Date | null;
  actor: string;
  reason: string;
  updated_at: Date;
}

function contactFrom(row: ContactRow): LiveContact {
  return {
    id: row.contact_id,
    name: row.name,
    integrations: row.integrations,
    version: row.version,
    retiredAt: row.retired_at ? iso(row.retired_at) : null,
    actor: row.actor,
    reason: row.reason,
    updatedAt: iso(row.updated_at),
  };
}

export function createPgNotify(sql: Sql): AlertNotifyStore {
  const lock = async (tx: Sql | TransactionSql): Promise<void> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ops.alert.notify'))`;
  };
  const readRoute = async (tx: Sql | TransactionSql): Promise<RouteTree | null> => {
    const [row] = await tx<RouteRow[]>`SELECT body, version, actor, reason, updated_at FROM ops.alert_route_policy WHERE id = 1`;
    if (!row) return null;
    const body: RouteBody = {
      ...row.body,
      timing: timingStored(row.body?.timing),
      mute: row.body?.mute ?? null,
      active: row.body?.active ?? null,
    };
    return treeOf(body, row.version, row.actor, row.reason, iso(row.updated_at));
  };
  const readContact = async (tx: Sql | TransactionSql, id: string): Promise<LiveContact | null> => {
    const [row] = await tx<
      ContactRow[]
    >`SELECT contact_id, name, integrations, version, retired_at, actor, reason, updated_at FROM ops.alert_contacts WHERE contact_id = ${id}`;
    return row ? contactFrom(row) : null;
  };
  const audit = async (
    tx: Sql | TransactionSql,
    action: string,
    subject: string,
    before: unknown,
    after: unknown,
    actor: string,
    reason: string,
    key: string,
    fingerprint: string,
    at: string,
  ): Promise<void> => {
    // One key names one change across every desk action; a key another action used is a conflict, not a 23505.
    const [taken] = await tx<{ action: string }[]>`SELECT action FROM ops.alert_notify_audit WHERE idempotency_key = ${key}`;
    if (taken) conflict(taken.action);
    await tx`INSERT INTO ops.alert_notify_audit (action, subject, before, after, actor, reason, idempotency_key, fingerprint, at)
      VALUES (${action}, ${subject}, ${before === null ? null : tx.json(before as never)}, ${after === null ? null : tx.json(after as never)}, ${actor}, ${reason}, ${key}, ${fingerprint}, ${at})`;
  };

  return {
    async getRoute() {
      return readRoute(sql);
    },
    async saveRoute(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = routeFingerprint(input);
      const body = parseRoute(input);
      return sql.begin(async (tx) => {
        await lock(tx);
        const [prior] = await tx<{ fingerprint: string; body: RouteBody; version: number; actor: string; reason: string; at: Date }[]>`
          SELECT fingerprint, body, version, actor, reason, at FROM ops.alert_route_versions WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict('routing tree');
          return treeOf(prior.body, prior.version, prior.actor, prior.reason, iso(prior.at));
        }
        const current = await readRoute(tx);
        for (const id of contactIdsOf(body)) {
          const contact = await readContact(tx, id);
          if (!contact || contact.retiredAt)
            throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, `Contact ${id} is not saved. The tree was not saved.`);
        }
        const currentVersion = current?.version;
        if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
          throw new OpsError(
            OPS_ALERT_ROUTE_VERSION_STALE,
            currentVersion !== undefined
              ? `The routing tree is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new tree'}.`
              : 'No routing tree to update.',
          );
        }
        const version = (currentVersion ?? 0) + 1;
        const saved = treeOf(body, version, actor, reason, input.at);
        if (!current) {
          await tx`INSERT INTO ops.alert_route_policy (id, body, version, actor, reason, updated_at) VALUES (1, ${tx.json(body as never)}, ${version}, ${actor}, ${reason}, ${input.at})`;
        } else {
          await tx`UPDATE ops.alert_route_policy SET body = ${tx.json(body as never)}, version = ${version}, actor = ${actor}, reason = ${reason}, updated_at = ${input.at} WHERE id = 1`;
        }
        await tx`INSERT INTO ops.alert_route_versions (version, body, actor, reason, idempotency_key, fingerprint, at)
          VALUES (${version}, ${tx.json(body as never)}, ${actor}, ${reason}, ${input.key}, ${fingerprint}, ${input.at})`;
        await audit(tx, 'route.saved', 'route', current, saved, actor, reason, input.key, fingerprint, input.at);
        await tx`INSERT INTO ops.alert_outbox (event, idempotency_key, payload, created_at)
          VALUES ('coreOpsAlertPolicyUpdated', ${policyEventKey(version)}, ${tx.json({ version, actor, changedAt: input.at })}, ${input.at})
          ON CONFLICT (idempotency_key) DO NOTHING`;
        return saved;
      });
    },
    async resolve(labels) {
      const route = await readRoute(sql);
      if (!route) throw new OpsError(OPS_ALERT_ROUTE_UNSET, 'No routing tree is saved. Nothing was routed.');
      return resolveRoute(route, labels);
    },
    async createSilence(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const id = slug(input.id, 'The silence id is blank. Nothing was saved.');
      const endsAt = parseSilenceEnd(input.endsAt);
      const matchers = parseMatchers(input.matchers);
      const fingerprint = fingerprintOf({ op: 'silence', id, matchers, endsAt });
      return sql.begin(async (tx) => {
        await lock(tx);
        const [prior] = await tx<
          {
            fingerprint: string;
            silence_id: string;
            matchers: OpsAlertSilence['matchers'];
            ends_at: Date;
            actor: string;
            reason: string;
            created_at: Date;
          }[]
        >`
          SELECT fingerprint, silence_id, matchers, ends_at, actor, reason, created_at FROM ops.alert_silences WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict('silence');
          return {
            id: prior.silence_id,
            matchers: prior.matchers,
            endsAt: iso(prior.ends_at),
            actor: prior.actor,
            reason: prior.reason,
            createdAt: iso(prior.created_at),
          };
        }
        const [taken] = await tx<{ silence_id: string }[]>`SELECT silence_id FROM ops.alert_silences WHERE silence_id = ${id}`;
        if (taken) throw new OpsError(OPS_SILENCE_ID_TAKEN, 'That silence id is already stored. Nothing was saved.');
        await tx`INSERT INTO ops.alert_silences (silence_id, matchers, ends_at, actor, reason, idempotency_key, fingerprint, created_at)
          VALUES (${id}, ${tx.json(matchers as never)}, ${endsAt}, ${actor}, ${reason}, ${input.key}, ${fingerprint}, ${input.at})`;
        const silence: OpsAlertSilence = { id, matchers, endsAt, actor, reason, createdAt: input.at };
        await audit(tx, 'silence.created', id, null, silence, actor, reason, input.key, fingerprint, input.at);
        return silence;
      });
    },
    async getSilence(id) {
      const [row] = await sql<
        { silence_id: string; matchers: OpsAlertSilence['matchers']; ends_at: Date; actor: string; reason: string; created_at: Date }[]
      >`
        SELECT silence_id, matchers, ends_at, actor, reason, created_at FROM ops.alert_silences WHERE silence_id = ${id}`;
      if (!row) return null;
      return {
        id: row.silence_id,
        matchers: row.matchers,
        endsAt: iso(row.ends_at),
        actor: row.actor,
        reason: row.reason,
        createdAt: iso(row.created_at),
      };
    },
    async saveContact(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = fingerprintOf({
        op: 'contact',
        id: input.id ?? null,
        name: input.name ?? null,
        expectedVersion: input.expectedVersion ?? null,
        integrations: input.integrations ?? null,
      });
      const id = slug(input.id, 'The contact id is blank. Nothing was saved.');
      const name = input.name?.trim() ?? '';
      if (!name || name.length > 120) throw new OpsError(OPS_ALERT_ROUTE_INVALID, 'The contact name is blank. Nothing was saved.');
      return sql.begin(async (tx) => {
        await lock(tx);
        const [prior] = await tx<{ fingerprint: string; snapshot: OpsAlertContact }[]>`
          SELECT fingerprint, snapshot FROM ops.alert_contact_versions WHERE idempotency_key = ${input.key}`;
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict('contact point');
          return prior.snapshot;
        }
        const current = await readContact(tx, id);
        const currentVersion = current?.version;
        if (currentVersion !== input.expectedVersion && !(currentVersion === undefined && input.expectedVersion === undefined)) {
          throw new OpsError(
            OPS_CONTACT_VERSION_STALE,
            currentVersion !== undefined
              ? `The contact is at version ${currentVersion}, not ${input.expectedVersion ?? 'a new contact'}.`
              : 'No such contact to update.',
          );
        }
        const integrations = parseIntegrations(input.integrations, current?.integrations ?? []);
        const version = (currentVersion ?? 0) + 1;
        const saved: LiveContact = { id, name, integrations, version, retiredAt: null, actor, reason, updatedAt: input.at };
        if (!current) {
          await tx`INSERT INTO ops.alert_contacts (contact_id, name, integrations, version, retired_at, actor, reason, updated_at)
            VALUES (${id}, ${name}, ${tx.json(integrations as never)}, ${version}, NULL, ${actor}, ${reason}, ${input.at})`;
        } else {
          await tx`UPDATE ops.alert_contacts SET name = ${name}, integrations = ${tx.json(integrations as never)}, version = ${version}, retired_at = NULL, actor = ${actor}, reason = ${reason}, updated_at = ${input.at} WHERE contact_id = ${id}`;
        }
        const contact = shown(saved);
        await tx`INSERT INTO ops.alert_contact_versions (contact_id, version, snapshot, actor, reason, idempotency_key, fingerprint, at)
          VALUES (${id}, ${version}, ${tx.json(contact as never)}, ${actor}, ${reason}, ${input.key}, ${fingerprint}, ${input.at})`;
        await audit(tx, 'contact.saved', id, current ? shown(current) : null, contact, actor, reason, input.key, fingerprint, input.at);
        return contact;
      });
    },
    async getContact(id) {
      const found = await readContact(sql, id);
      return found ? shown(found) : null;
    },
    async listContacts(limit) {
      const rows = await sql<ContactRow[]>`
        SELECT contact_id, name, integrations, version, retired_at, actor, reason, updated_at
        FROM ops.alert_contacts WHERE retired_at IS NULL ORDER BY contact_id LIMIT ${limit}`;
      return rows.map((row) => shown(contactFrom(row)));
    },
    async retireContact(input) {
      const actor = actorOf(input.actor);
      const reason = reasonOf(input.reason);
      const fingerprint = fingerprintOf({ op: 'retire-contact', id: input.id });
      return sql.begin(async (tx) => {
        await lock(tx);
        const [prior] = await tx<{ fingerprint: string; after: OpsAlertContact }[]>`
          SELECT fingerprint, after FROM ops.alert_notify_audit WHERE idempotency_key = ${input.key} AND action = 'contact.retired'`;
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict('contact point');
          return prior.after;
        }
        const found = await readContact(tx, input.id);
        if (!found) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such contact point.');
        const route = await readRoute(tx);
        if (routeMentions(route, input.id))
          throw new OpsError(OPS_CONTACT_POINT_IN_USE, 'A routing policy uses this contact. It was not retired.');
        if (found.retiredAt) return shown(found);
        const saved: LiveContact = { ...found, retiredAt: input.at, actor, reason, updatedAt: input.at };
        await tx`UPDATE ops.alert_contacts SET retired_at = ${input.at}, actor = ${actor}, reason = ${reason}, updated_at = ${input.at} WHERE contact_id = ${input.id}`;
        const contact = shown(saved);
        await audit(tx, 'contact.retired', input.id, shown(found), contact, actor, reason, input.key, fingerprint, input.at);
        return contact;
      });
    },
    testChannel(input) {
      return pgSend(sql, input, 'channel.tested');
    },
    async groupingSend(input) {
      const fingerprint = fingerprintOf({ op: 'group', key: input.key, ruleId: input.ruleId, labels: input.labels });
      const decided = await sql.begin(async (tx) => {
        await lock(tx);
        const [prior] = await tx<{ fingerprint: string; action: string; after: { code?: string; suppressed?: GroupSuppression } | null }[]>`
          SELECT fingerprint, action, after FROM ops.alert_notify_audit
          WHERE idempotency_key = ${input.key} AND action IN ('grouping.refused', 'grouping.suppressed')`;
        if (prior) {
          if (prior.fingerprint !== fingerprint) conflict('grouped notice');
          if (prior.action === 'grouping.suppressed') {
            return { kind: 'stop' as const, sent: false, code: null, notificationId: null, suppressed: prior.after?.suppressed ?? null };
          }
          return {
            kind: 'stop' as const,
            sent: false,
            code: prior.after?.code ?? OPS_GROUP_TIMING_UNSET,
            notificationId: null,
            suppressed: null,
          };
        }
        // A key that already reached the send path is not decided again: a later silence or route edit must not
        // change what the same key did. The send replays its stored attempt or finishes a failed one.
        const [noted] = await tx<{ contact_id: string; integration_id: string }[]>`
          SELECT contact_id, integration_id FROM ops.alert_notifications WHERE idempotency_key = ${input.key}`;
        if (noted) return { kind: 'send' as const, contactId: noted.contact_id, integrationId: noted.integration_id as string | null };
        const route = await readRoute(tx);
        if (!route) throw new OpsError(OPS_ALERT_ROUTE_UNSET, 'No routing tree is saved. Nothing was sent.');
        const hit = resolveRoute(route, input.labels);
        const silenceRows = await tx<
          { silence_id: string; matchers: OpsAlertSilence['matchers'] }[]
        >`SELECT silence_id, matchers FROM ops.alert_silences WHERE ends_at > ${input.at} ORDER BY silence_id`;
        const silence = silenceRows.find((row) => matchersHold(row.matchers, input.labels));
        const block = groupDecision({
          timing: timingStored(hit.timing),
          mute: route.mute,
          active: route.active,
          silenceId: silence?.silence_id ?? null,
          now: input.at,
        });
        if (block.outcome === 'send') return { kind: 'send' as const, contactId: hit.primaryContact, integrationId: null as string | null };
        const actor = actorOf(input.actor);
        const reason = reasonOf(input.reason);
        if (block.outcome === 'refused') {
          await audit(tx, 'grouping.refused', input.ruleId, null, { code: block.code }, actor, reason, input.key, fingerprint, input.at);
          return { kind: 'stop' as const, sent: false, code: block.code, notificationId: null, suppressed: null };
        }
        await audit(
          tx,
          'grouping.suppressed',
          input.ruleId,
          null,
          { suppressed: block.suppressed },
          actor,
          reason,
          input.key,
          fingerprint,
          input.at,
        );
        return { kind: 'stop' as const, sent: false, code: null, notificationId: null, suppressed: block.suppressed };
      });
      if (decided.kind === 'stop') {
        return { sent: decided.sent, code: decided.code, notificationId: decided.notificationId, suppressed: decided.suppressed };
      }
      const contact = await readContact(sql, decided.contactId);
      if (!contact || contact.retiredAt) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such contact point.');
      const integration =
        decided.integrationId === null ? contact.integrations[0] : contact.integrations.find((item) => item.id === decided.integrationId);
      if (!integration) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'The contact has no integration. Nothing was sent.');
      const result = await pgSend(
        sql,
        { contactId: contact.id, integrationId: integration.id, key: input.key, actor: input.actor, reason: input.reason, at: input.at },
        'grouping.sent',
      );
      return { sent: result.code === null, code: result.code, notificationId: result.notificationId, suppressed: null };
    },
    async attempts(contactId, limit) {
      const rows = await sql<
        {
          notification_id: string;
          attempt: number;
          contact_id: string;
          integration_id: string;
          code: string | null;
          actor: string;
          reason: string;
          at: Date;
        }[]
      >`
        SELECT a.notification_id, a.attempt, n.contact_id, n.integration_id, a.code, a.actor, a.reason, a.at
        FROM ops.alert_channel_attempts a
        JOIN ops.alert_notifications n ON n.notification_id = a.notification_id
        WHERE n.contact_id = ${contactId}
        ORDER BY a.at DESC, a.attempt DESC
        LIMIT ${limit}`;
      return rows.map((row) => ({
        notificationId: row.notification_id,
        attempt: row.attempt,
        contactId: row.contact_id,
        integrationId: row.integration_id,
        code: row.code,
        actor: row.actor,
        reason: row.reason,
        at: iso(row.at),
      }));
    },
  };
}

async function pgSend(sql: Sql, input: SendInput, action: 'channel.tested' | 'grouping.sent'): Promise<TestResult> {
  const actor = actorOf(input.actor);
  const reason = reasonOf(input.reason);
  const fingerprint = fingerprintOf({ op: action, key: input.key, contactId: input.contactId, integrationId: input.integrationId });
  // The claim commits under the transaction lock, before any POST. Attempts stay append-only, so the claim is its own row.
  const prepare = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ops.alert.notify'))`;
    const rows = await tx<{ notification_id: string; attempt: number; fingerprint: string; code: string | null }[]>`
      SELECT notification_id, attempt, fingerprint, code FROM ops.alert_channel_attempts WHERE idempotency_key = ${input.key} ORDER BY attempt`;
    if (rows.some((row) => row.fingerprint !== fingerprint)) conflict('channel test');
    const [held] = await tx<{ action: string; fingerprint: string }[]>`
      SELECT action, fingerprint FROM ops.alert_notify_audit WHERE idempotency_key = ${input.key}`;
    if (held && (held.action !== action || held.fingerprint !== fingerprint)) conflict(held.action);
    const done = rows.find((row) => row.code === null || VENDORS.has(row.code ?? ''));
    if (done) return { kind: 'done' as const, notificationId: done.notification_id, code: done.code };
    const [contact] = await tx<
      ContactRow[]
    >`SELECT contact_id, name, integrations, version, retired_at, actor, reason, updated_at FROM ops.alert_contacts WHERE contact_id = ${input.contactId}`;
    const live = contact ? contactFrom(contact) : null;
    if (!live || live.retiredAt) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such contact point.');
    const integration = live.integrations.find((item) => item.id === input.integrationId);
    if (!integration) throw new OpsError(OPS_CONTACT_POINT_NOT_FOUND, 'No such integration.');
    assertAuthExclusive(integration);
    const [noted] = await tx<{ notification_id: string }[]>`
      SELECT notification_id FROM ops.alert_notifications WHERE idempotency_key = ${input.key}`;
    let id = rows[0]?.notification_id ?? noted?.notification_id ?? null;
    if (!id) {
      const [max] = await tx<{ ordinal: number }[]>`
        SELECT ordinal FROM ops.alert_notifications WHERE contact_id = ${input.contactId} AND integration_id = ${input.integrationId} ORDER BY ordinal DESC LIMIT 1`;
      const ordinal = (max?.ordinal ?? 0) + 1;
      id = notificationId(input.contactId, ordinal);
      await tx`INSERT INTO ops.alert_notifications (notification_id, contact_id, integration_id, ordinal, idempotency_key)
        VALUES (${id}, ${input.contactId}, ${input.integrationId}, ${ordinal}, ${input.key})`;
    }
    const attempt = (rows.at(-1)?.attempt ?? 0) + 1;
    const [claim] = await tx<{ fingerprint: string }[]>`
      SELECT fingerprint FROM ops.alert_send_claims WHERE idempotency_key = ${input.key} AND attempt = ${attempt}`;
    if (claim) {
      if (claim.fingerprint !== fingerprint) conflict('channel test');
    } else {
      await tx`INSERT INTO ops.alert_send_claims (idempotency_key, attempt, notification_id, fingerprint, claimed_at)
        VALUES (${input.key}, ${attempt}, ${id}, ${fingerprint}, ${input.at})`;
    }
    return { kind: 'finish' as const, id, attempt, integration };
  });
  if (prepare.kind === 'done') return { notificationId: prepare.notificationId, code: prepare.code, stored: true };
  // The row lock is held across the POST. The other same-key caller blocks here, then sees the attempt and does not POST.
  // A crash drops the lock and leaves the claim, so the same key can finish it. This is not a session advisory lock.
  return sql.begin(async (tx) => {
    const [claim] = await tx<{ fingerprint: string }[]>`
      SELECT fingerprint FROM ops.alert_send_claims
      WHERE idempotency_key = ${input.key} AND attempt = ${prepare.attempt}
      FOR UPDATE`;
    if (!claim || claim.fingerprint !== fingerprint) conflict('channel test');
    const [existing] = await tx<{ code: string | null }[]>`
      SELECT code FROM ops.alert_channel_attempts WHERE idempotency_key = ${input.key} AND attempt = ${prepare.attempt}`;
    if (existing) return { notificationId: prepare.id, code: existing.code, stored: true as const };
    const vendor = vendorCode(prepare.integration.kind);
    let code: string | null = vendor;
    if (!vendor) {
      const body = webhookBody({
        notificationId: prepare.id,
        contactId: input.contactId,
        integrationId: input.integrationId,
        at: input.at,
      });
      const delivery = deliveryFor(prepare.integration, body);
      code = (await post(delivery, body)) ? null : OPS_CHANNEL_DELIVERY_FAILED;
    }
    await tx`INSERT INTO ops.alert_channel_attempts (notification_id, attempt, idempotency_key, fingerprint, code, actor, reason, at)
      VALUES (${prepare.id}, ${prepare.attempt}, ${input.key}, ${fingerprint}, ${code}, ${actor}, ${reason}, ${input.at})`;
    const [audited] = await tx<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM ops.alert_notify_audit WHERE idempotency_key = ${input.key}`;
    if (!audited) {
      await tx`INSERT INTO ops.alert_notify_audit (action, subject, before, after, actor, reason, idempotency_key, fingerprint, at)
        VALUES (${action}, ${input.contactId}, NULL, ${tx.json({ notificationId: prepare.id, code })}, ${actor}, ${reason}, ${input.key}, ${fingerprint}, ${input.at})`;
    }
    return { notificationId: prepare.id, code, stored: true as const };
  });
}
