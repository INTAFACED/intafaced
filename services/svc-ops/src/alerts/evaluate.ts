import { createHash } from 'node:crypto';
import type { OpsAlertHealth, OpsAlertRule, OpsAlertState } from '@intafaced/contracts';
import { breaches, type SignalReading } from './signals.js';

export interface InstanceState {
  readonly state: OpsAlertState;
  readonly health: OpsAlertHealth;
  /** Episode counter: +1 each time the instance opens. Not a clock. */
  readonly epoch: number;
  readonly pendingSince: string | null;
  readonly firingSince: string | null;
  readonly lastEvaluatedAt: string;
  readonly lastValue: string | null;
  readonly lastCode: string | null;
  /** The rule said "keep last" and this check was unhealthy: the state shown is the previous one. */
  readonly kept: boolean;
}

export type AlertTransition =
  | { readonly kind: 'opened'; readonly state: 'firing' | 'error' | 'no_data'; readonly epoch: number; readonly at: string }
  | { readonly kind: 'resolved'; readonly epoch: number; readonly at: string };

export interface StepResult {
  readonly next: InstanceState;
  readonly changed: boolean;
  readonly transitions: readonly AlertTransition[];
}

/** One instance per rule today: the rule's own label set. */
export function instanceOf(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function isDue(rule: OpsAlertRule, prev: InstanceState | null, nowMs: number): boolean {
  if (!prev) return true;
  return nowMs - Date.parse(prev.lastEvaluatedAt) >= rule.intervalSeconds * 1000;
}

const INITIAL = (at: string): InstanceState => ({
  state: 'normal',
  health: 'ok',
  epoch: 0,
  pendingSince: null,
  firingSince: null,
  lastEvaluatedAt: at,
  lastValue: null,
  lastCode: null,
  kept: false,
});

/**
 * One evaluation, pure. normal -> pending (condition holds, waiting out the pending period) -> firing; back to normal when it stops
 * holding. A check that errors or returns no data follows the rule's own handling, which defaults to alerting (fail closed).
 */
export function step(rule: OpsAlertRule, prev: InstanceState | null, reading: SignalReading, at: string): StepResult {
  const base = prev ?? INITIAL(at);
  const health: OpsAlertHealth = reading.status === 'ok' ? 'ok' : reading.status;
  const handling = reading.status === 'ok' ? null : reading.status === 'error' ? rule.execError : rule.noData;

  const lastValue = reading.status === 'ok' ? reading.value : null;
  const lastCode = reading.status === 'error' ? reading.code : null;

  if (handling === 'keep_last') {
    const next: InstanceState = { ...base, health, lastEvaluatedAt: at, lastValue, lastCode, kept: true };
    return { next, changed: prev === null || prev.health !== health || !prev.kept, transitions: [] };
  }

  let breached: boolean;
  if (handling === 'alerting') breached = true;
  else if (handling === 'normal') breached = false;
  else {
    const result = reading.status === 'ok' ? breaches(rule.condition.operator, reading.value, rule.condition.threshold) : null;
    // A value that cannot be compared is an unreadable check, not a healthy one.
    if (result === null) {
      return step(rule, prev, { status: 'error', code: 'ops.alert_signal_value_invalid' }, at);
    }
    breached = result;
  }

  const transitions: AlertTransition[] = [];
  let state: OpsAlertState = base.state;
  let pendingSince = base.pendingSince;
  let firingSince = base.firingSince;
  let epoch = base.epoch;
  const open = (): void => {
    epoch += 1;
    state = 'firing';
    firingSince = at;
    transitions.push({ kind: 'opened', state: health === 'ok' ? 'firing' : health, epoch, at });
  };

  if (breached) {
    if (base.state === 'normal') {
      if (rule.pendingSeconds === 0) open();
      else {
        state = 'pending';
        pendingSince = at;
      }
    } else if (base.state === 'pending') {
      const waited = Date.parse(at) - Date.parse(base.pendingSince ?? at);
      if (waited >= rule.pendingSeconds * 1000) open();
    }
  } else {
    if (base.state === 'firing') transitions.push({ kind: 'resolved', epoch: base.epoch, at });
    state = 'normal';
    pendingSince = null;
    firingSince = null;
  }

  const next: InstanceState = { state, health, epoch, pendingSince, firingSince, lastEvaluatedAt: at, lastValue, lastCode, kept: false };
  return { next, changed: prev === null || prev.state !== state || prev.health !== health || prev.kept, transitions };
}
