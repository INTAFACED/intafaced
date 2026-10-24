import { createHash, randomUUID } from 'node:crypto';
import { hasAnalyticsMetric, type OpsAlertRule, type OpsAlertRuleDraft } from '@intafaced/contracts';
import {
  OPS_ALERT_INTERVAL_UNSET,
  OPS_ALERT_RULE_NOT_RETIRED,
  OPS_ALERT_RULE_RETIRED,
  OPS_ALERT_RULE_VERSION_STALE,
  OPS_ALERT_SIGNAL_UNKNOWN,
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_ALERT_THRESHOLD_UNSET,
  OPS_SILENCE_NOT_FOUND,
  OpsError,
} from '../codes.js';
import { matchersHold, silenceActive } from './notify.js';
import type { AlertNotifyStore, ContactSave, GroupInput, RouteSave, SendInput, SilenceSave } from './notify-store.js';

export type RuleChange = 'created' | 'updated' | 'paused' | 'resumed' | 'retired' | 'restored';

/** What a rule is, without its bookkeeping. Every number is set: a blank never reaches the store. */
export type RuleFields = Pick<
  OpsAlertRule,
  | 'name'
  | 'folder'
  | 'group'
  | 'signal'
  | 'condition'
  | 'intervalSeconds'
  | 'pendingSeconds'
  | 'labels'
  | 'annotations'
  | 'noData'
  | 'execError'
>;

export interface RuleState extends RuleFields {
  readonly paused: boolean;
  readonly retired: boolean;
}

export interface ApplyCommand {
  readonly key: string;
  readonly fingerprint: string;
  /** Null creates a rule. */
  readonly ruleId: string | null;
  readonly newId: string;
  readonly change: RuleChange;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  /** Runs against the locked current row, so a stale edit is refused on what is stored, not on what the caller last saw. */
  readonly compute: (current: OpsAlertRule | null) => RuleState;
}

export interface ListFilter {
  readonly folder?: string;
  readonly group?: string;
  readonly nameContains?: string;
  readonly label?: { readonly key: string; readonly value: string };
  readonly includeRetired: boolean;
  readonly limit: number;
  readonly after?: RuleCursor;
}

export interface RuleCursor {
  readonly folder: string;
  readonly group: string;
  readonly name: string;
  readonly id: string;
}

export interface RuleVersion {
  readonly version: number;
  readonly change: RuleChange;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
  readonly rule: OpsAlertRule;
}

export interface AlertRuleStore {
  apply(cmd: ApplyCommand): Promise<OpsAlertRule>;
  get(id: string): Promise<OpsAlertRule | null>;
  list(filter: ListFilter): Promise<readonly OpsAlertRule[]>;
  versions(id: string, limit: number): Promise<readonly RuleVersion[]>;
}

/** A blank threshold, interval or pending period refuses by name; nothing here picks a number. */
export function resolveDraft(draft: OpsAlertRuleDraft): RuleFields {
  if (!hasAnalyticsMetric(draft.signal)) {
    throw new OpsError(
      OPS_ALERT_SIGNAL_UNKNOWN,
      `"${draft.signal}" is not a platform signal. A rule watches an internal metric, never an outside source.`,
    );
  }
  if (draft.condition.threshold === undefined) {
    throw new OpsError(OPS_ALERT_THRESHOLD_UNSET, 'condition.threshold is blank. A rule is not saved without one.');
  }
  if (draft.intervalSeconds === undefined) {
    throw new OpsError(OPS_ALERT_INTERVAL_UNSET, 'intervalSeconds is blank. A rule is not saved without an evaluation interval.');
  }
  if (draft.pendingSeconds === undefined) {
    throw new OpsError(
      OPS_ALERT_INTERVAL_UNSET,
      'pendingSeconds is blank. A rule is not saved without a pending period (0 is a value you choose).',
    );
  }
  return {
    name: draft.name,
    folder: draft.folder,
    group: draft.group,
    signal: draft.signal,
    condition: { operator: draft.condition.operator, threshold: draft.condition.threshold },
    intervalSeconds: draft.intervalSeconds,
    pendingSeconds: draft.pendingSeconds,
    labels: draft.labels,
    annotations: draft.annotations,
    noData: draft.noData,
    execError: draft.execError,
  };
}

/** Same label set, same hash, whatever the key order. An empty set has none: unlabelled rules are not routed together. */
export function labelsHash(labels: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return null;
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function stateOf(rule: OpsAlertRule): RuleState {
  const { name, folder, group, signal, condition, intervalSeconds, pendingSeconds, labels, annotations, noData, execError } = rule;
  return {
    name,
    folder,
    group,
    signal,
    condition,
    intervalSeconds,
    pendingSeconds,
    labels,
    annotations,
    noData,
    execError,
    paused: rule.paused,
    retired: rule.retiredAt !== null,
  };
}

function live(current: OpsAlertRule | null, expectedVersion: number): OpsAlertRule {
  if (!current) throw new Error('ops.alert_rule_missing_in_compute');
  if (current.retiredAt !== null) throw new OpsError(OPS_ALERT_RULE_RETIRED, 'The rule is retired. Restore it first.');
  if (current.version !== expectedVersion) {
    throw new OpsError(OPS_ALERT_RULE_VERSION_STALE, `The rule is at version ${current.version}, not ${expectedVersion}. Reload it.`);
  }
  return current;
}

export interface Actor {
  readonly id: string;
  readonly reason: string;
  readonly key: string;
}

/** Enforced alert-quality requirements. Absent means this deployment has no policy store, so a save is not blocked. */
export interface AlertQualityGate {
  assertWritable(fields: RuleFields): Promise<void>;
}

export class AlertRules {
  constructor(
    private readonly store: AlertRuleStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
    private readonly quality?: AlertQualityGate,
  ) {}

  async create(draft: OpsAlertRuleDraft, who: Actor): Promise<OpsAlertRule> {
    const fields = resolveDraft(draft);
    await this.quality?.assertWritable(fields);
    return this.store.apply({
      key: who.key,
      fingerprint: fingerprintOf({ op: 'create', draft: fields }),
      ruleId: null,
      newId: this.newId(),
      change: 'created',
      actor: who.id,
      reason: who.reason,
      at: this.now(),
      compute: () => ({ ...fields, paused: false, retired: false }),
    });
  }

  async update(ruleId: string, expectedVersion: number, draft: OpsAlertRuleDraft, who: Actor): Promise<OpsAlertRule> {
    const fields = resolveDraft(draft);
    await this.quality?.assertWritable(fields);
    return this.store.apply({
      key: who.key,
      fingerprint: fingerprintOf({ op: 'update', ruleId, expectedVersion, draft: fields }),
      ruleId,
      newId: ruleId,
      change: 'updated',
      actor: who.id,
      reason: who.reason,
      at: this.now(),
      compute: (current) => ({ ...fields, paused: live(current, expectedVersion).paused, retired: false }),
    });
  }

  setPaused(ruleId: string, expectedVersion: number, paused: boolean, who: Actor): Promise<OpsAlertRule> {
    return this.store.apply({
      key: who.key,
      fingerprint: fingerprintOf({ op: paused ? 'pause' : 'resume', ruleId, expectedVersion }),
      ruleId,
      newId: ruleId,
      change: paused ? 'paused' : 'resumed',
      actor: who.id,
      reason: who.reason,
      at: this.now(),
      compute: (current) => ({ ...stateOf(live(current, expectedVersion)), paused }),
    });
  }

  retire(ruleId: string, expectedVersion: number, who: Actor): Promise<OpsAlertRule> {
    return this.store.apply({
      key: who.key,
      fingerprint: fingerprintOf({ op: 'retire', ruleId, expectedVersion }),
      ruleId,
      newId: ruleId,
      change: 'retired',
      actor: who.id,
      reason: who.reason,
      at: this.now(),
      compute: (current) => ({ ...stateOf(live(current, expectedVersion)), retired: true }),
    });
  }

  restore(ruleId: string, expectedVersion: number, who: Actor): Promise<OpsAlertRule> {
    return this.store.apply({
      key: who.key,
      fingerprint: fingerprintOf({ op: 'restore', ruleId, expectedVersion }),
      ruleId,
      newId: ruleId,
      change: 'restored',
      actor: who.id,
      reason: who.reason,
      at: this.now(),
      compute: (current) => {
        if (!current) throw new Error('ops.alert_rule_missing_in_compute');
        if (current.retiredAt === null) throw new OpsError(OPS_ALERT_RULE_NOT_RETIRED, 'The rule is not retired.');
        if (current.version !== expectedVersion) {
          throw new OpsError(OPS_ALERT_RULE_VERSION_STALE, `The rule is at version ${current.version}, not ${expectedVersion}. Reload it.`);
        }
        return { ...stateOf(current), retired: false };
      },
    });
  }

  get(id: string) {
    return this.store.get(id);
  }
  list(filter: ListFilter) {
    return this.store.list(filter);
  }
  versions(id: string, limit: number) {
    return this.store.versions(id, limit);
  }

  /** Routing, silences and contact points share the alert desk. Absent means nothing is saved. */
  notify(): AlertNotifyStore {
    const gate = this.quality as (AlertQualityGate & Partial<AlertNotifyStore>) | undefined;
    if (!gate || typeof gate.saveRoute !== 'function') {
      throw new OpsError(OPS_ALERT_STORAGE_UNCONFIGURED, 'No durable storage is configured for alert routing. Nothing was saved.');
    }
    return gate as AlertNotifyStore;
  }

  saveRoute(input: Omit<RouteSave, 'actor' | 'reason' | 'at'>, who: Actor) {
    return this.notify().saveRoute({ ...input, actor: who.id, reason: who.reason, at: this.now() });
  }

  getRoute() {
    return this.notify().getRoute();
  }

  resolve(labels: Readonly<Record<string, string>>) {
    return this.notify().resolve(labels);
  }

  createSilence(input: Omit<SilenceSave, 'actor' | 'reason' | 'at'>, who: Actor) {
    return this.notify().createSilence({ ...input, actor: who.id, reason: who.reason, at: this.now() });
  }

  async getSilence(id: string) {
    const found = await this.notify().getSilence(id);
    if (!found) throw new OpsError(OPS_SILENCE_NOT_FOUND, 'No such silence.');
    return found;
  }

  async previewSilence(
    id: string,
    limit: number,
    read: (
      offset: number,
      limit: number,
    ) => Promise<readonly { ruleId: string; name: string; instance: string; labels: Readonly<Record<string, string>>; state: string }[]>,
  ) {
    const silence = await this.getSilence(id);
    const active = silenceActive(silence, this.now());
    if (!active || limit < 1) return { endsAt: silence.endsAt, active, alerts: [], truncated: false };
    const alerts: { ruleId: string; name: string; instance: string; labels: Readonly<Record<string, string>>; state: string }[] = [];
    let offset = 0;
    let truncated = false;
    // Truncated only when one more row that the silence matches exists past the page.
    while (!truncated) {
      const batch = await read(offset, limit);
      for (const row of batch) {
        if (!matchersHold(silence.matchers, row.labels)) continue;
        if (alerts.length === limit) {
          truncated = true;
          break;
        }
        alerts.push(row);
      }
      if (batch.length < limit) break;
      offset += batch.length;
    }
    return { endsAt: silence.endsAt, active: true, alerts, truncated };
  }

  saveContact(input: Omit<ContactSave, 'actor' | 'reason' | 'at'>, who: Actor) {
    return this.notify().saveContact({ ...input, actor: who.id, reason: who.reason, at: this.now() });
  }

  getContact(id: string) {
    return this.notify().getContact(id);
  }

  listContacts(limit: number) {
    return this.notify().listContacts(limit);
  }

  retireContact(id: string, who: Actor) {
    return this.notify().retireContact({ id, key: who.key, actor: who.id, reason: who.reason, at: this.now() });
  }

  testChannel(input: Omit<SendInput, 'actor' | 'reason' | 'at'>, who: Actor) {
    return this.notify().testChannel({ ...input, actor: who.id, reason: who.reason, at: this.now() });
  }

  groupingSend(input: Omit<GroupInput, 'actor' | 'reason' | 'at'>, who: Actor) {
    return this.notify().groupingSend({ ...input, actor: who.id, reason: who.reason, at: this.now() });
  }

  attempts(contactId: string, limit: number) {
    return this.notify().attempts(contactId, limit);
  }
}
