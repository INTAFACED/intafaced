import { close, instanceOf, isDue, step } from './evaluate.js';
import { ALERT_EVALUATOR_ACTOR, ALERT_EVALUATOR_REASON, fingerprintOf, pipelineHeartbeatKey, type AlertDeskStore } from './desk-store.js';
import type { AlertRuleStore } from './rules.js';
import type { SignalReader } from './signals.js';
import type { AlertEventName, AlertOutbox, AlertStateStore } from './state-store.js';

/** The part of the event bus the publisher needs; `@intafaced/events` bus implementations satisfy it. */
export interface AlertBus {
  publish(name: AlertEventName, payload: never, opts: { idempotencyKey: string }): Promise<unknown>;
}

export interface EvaluatorDeps {
  readonly rules: AlertRuleStore;
  readonly state: AlertStateStore;
  readonly signals: SignalReader;
  readonly now?: () => string;
  /** When set, a completed cycle appends one pipeline beat. A thrown cycle writes nothing. */
  readonly desk?: Pick<AlertDeskStore, 'recordHeartbeat'>;
}

export interface TickReport {
  readonly evaluated: number;
  readonly opened: number;
  readonly resolved: number;
}

/**
 * Evaluates every live, unpaused rule whose interval has passed. State, history and the announcing events commit together under
 * a per-instance lock, so a restart re-reads the stored state: no firing alert is lost and none is announced twice.
 */
export class AlertEvaluator {
  private readonly now: () => string;
  constructor(private readonly deps: EvaluatorDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async tick(): Promise<TickReport> {
    const cycleStart = this.now();
    let evaluated = 0;
    let opened = 0;
    let resolved = 0;
    let cursor: { folder: string; group: string; name: string; id: string } | undefined;
    const count = (result: { transitions: readonly { kind: string }[] } | null): void => {
      for (const t of result?.transitions ?? []) t.kind === 'opened' ? (opened += 1) : (resolved += 1);
    };
    for (;;) {
      // Retired rules are listed too: one that was firing when it was retired is closed here.
      const page = await this.deps.rules.list({ includeRetired: true, limit: 200, ...(cursor ? { after: cursor } : {}) });
      const stored = await this.deps.state.states(page.map((r) => r.id));
      for (const rule of page) {
        const instance = instanceOf(rule.id);
        const prev = stored.get(rule.id) ?? null;
        if (rule.paused || rule.retiredAt !== null) {
          if (prev && prev.state !== 'normal') {
            const closed = await this.deps.state.evaluate(rule.id, instance, (locked) => (locked ? close(locked, this.now()) : null));
            if (closed) count(closed);
          }
          continue;
        }
        const startedAt = Date.parse(this.now());
        // Cheap pre-check outside the lock, so a rule that is not due costs no signal read; the lock re-checks against the stored state.
        if (!isDue(rule, prev, startedAt)) continue;
        const reading = await this.deps.signals.read(rule.signal);
        const at = this.now();
        const result = await this.deps.state.evaluate(rule.id, instance, (locked) =>
          isDue(rule, locked, startedAt) ? step(rule, locked, reading, at) : null,
        );
        if (!result) continue;
        evaluated += 1;
        count(result);
      }
      const last = page[page.length - 1];
      if (page.length < 200 || !last) break;
      cursor = { folder: last.folder, group: last.group, name: last.name, id: last.id };
    }
    if (this.deps.desk) {
      await this.deps.desk.recordHeartbeat({
        key: pipelineHeartbeatKey(cycleStart),
        fingerprint: fingerprintOf({ kind: 'pipeline', cycleStart }),
        actor: ALERT_EVALUATOR_ACTOR,
        reason: ALERT_EVALUATOR_REASON,
        at: this.now(),
      });
    }
    return { evaluated, opened, resolved };
  }
}

/**
 * Publishes the outbox in order. A row stays pending until the bus accepts it; a crash between accept and mark republishes the same
 * business key, which the bus drops as a duplicate and consumers handle idempotently.
 */
export class AlertOutboxPublisher {
  constructor(
    private readonly outbox: AlertOutbox,
    private readonly bus: AlertBus,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async runOnce(limit = 50): Promise<number> {
    let published = 0;
    for (const row of await this.outbox.pending(limit)) {
      try {
        await this.bus.publish(row.event, row.payload as never, { idempotencyKey: row.idempotencyKey });
        await this.outbox.markPublished(row.id, this.now());
        published += 1;
      } catch (err) {
        await this.outbox.markFailed(row.id, err instanceof Error ? err.message : 'publish failed');
        // Keep order: a later row must not overtake a failed one.
        break;
      }
    }
    return published;
  }
}
