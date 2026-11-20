import type { FeePort, HistoryPort } from '../engine/ports.js';
import { paperView } from '../paper/view.js';
import type { RunRepository } from '../runs/repository.js';
import type { StrategyRepository } from '../studio/repository.js';
import type { NotifyRepository, StoredAlert } from './repository.js';
import { fillEventId, renderTemplate } from './rules.js';

/** What the sweep publishes for one fill under one alert: `intafaced.quant.order.filled`'s payload. */
export interface FillAnnouncement {
  readonly eventId: string;
  readonly userId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly runId: string;
  readonly alertId: string;
  readonly mode: 'paper';
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: string;
  readonly price: string;
  readonly filledAt: string;
  readonly message: string;
  readonly channels: ('email' | 'sms' | 'push')[];
}

/** Hands one announcement to the bus under its event id. Resolves null while no bus is connected: nothing is marked. */
export type FillSink = () => Promise<((fill: FillAnnouncement) => Promise<void>) | null>;

export interface SweepDeps {
  readonly notify: NotifyRepository;
  readonly runs: RunRepository;
  readonly strategies: StrategyRepository;
  readonly history: HistoryPort;
  readonly fees: FeePort;
  readonly sink: FillSink;
  readonly now?: () => number;
  readonly log?: (message: string, err?: unknown) => void;
}

/** A batch size for reading alerts and runs, not a business limit. */
const PAGE = 100;
/** How long after its stop a paper run's last fills are still looked for: a stop between two sweeps loses none. */
const STOPPED_GRACE_MS = 10 * 60_000;

/**
 * The server-side fill alert sweep (AL-live-06, AL-alerts-01). For each alert, the paper runs of its strategy version are
 * read as the screen reads them, from the exchange's own closed candles; each fill made at or after the alert was created
 * and not yet announced is published, then marked. Nothing here needs a browser. A crash between publish and mark
 * publishes the same event id again, and svc-notify writes one notice per id. Returns how many fills were published.
 */
export async function sweepFillAlerts(deps: SweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const publish = await deps.sink();
  if (!publish) return 0;
  let published = 0;
  let after: string | null = null;
  for (;;) {
    const page: readonly StoredAlert[] = await deps.notify.sweepAlerts({ after, limit: PAGE });
    for (const alert of page) {
      try {
        published += await sweepOne(deps, alert, publish, now());
      } catch (err) {
        // One alert that cannot be read (its run's candles are unreachable) waits for the next sweep; the rest go on.
        deps.log?.(`quant fill alert ${alert.id} not swept`, err);
      }
    }
    if (page.length < PAGE) return published;
    after = page[page.length - 1]!.id;
  }
}

async function sweepOne(
  deps: SweepDeps,
  alert: StoredAlert,
  publish: (fill: FillAnnouncement) => Promise<void>,
  nowMs: number,
): Promise<number> {
  const strategy = await deps.strategies.get({ accountId: alert.accountId, id: alert.strategyId });
  const version = strategy && !strategy.deletedAt ? strategy.versions.find((row) => row.version === alert.strategyVersion) : undefined;
  if (!strategy || !version || !version.modules) return 0;
  const settings = await deps.notify.settings({ accountId: alert.accountId, strategyId: alert.strategyId });
  const channels = (settings?.channels ?? ['inapp']).filter((channel): channel is 'email' | 'sms' | 'push' => channel !== 'inapp');
  const since = Date.parse(alert.createdAt);
  const runs = await deps.runs.paperRuns({ userId: alert.accountId, strategyId: alert.strategyId, limit: PAGE });
  let published = 0;
  for (const paper of runs) {
    if (paper.run.strategyVersion !== alert.strategyVersion) continue;
    if (paper.run.finished && Date.parse(paper.run.finished) < Math.max(since, nowMs - STOPPED_GRACE_MS)) continue;
    const view = await paperView(
      paper,
      { id: strategy.id, version: version.version, modules: version.modules, risk: version.risk },
      { fees: deps.fees, history: deps.history },
      nowMs,
    );
    if (view.trades.length === 0) continue;
    const announced = await deps.notify.announced({ alertId: alert.id, runId: view.runId });
    for (const [seq, trade] of view.trades.entries()) {
      if (announced.has(seq) || Date.parse(trade.ts) < since) continue;
      const eventId = fillEventId(alert.id, view.runId, seq);
      const message = renderTemplate(alert.template, {
        strategy: strategy.name,
        version: String(version.version),
        symbol: view.symbol,
        side: trade.side,
        qty: trade.qty,
        price: trade.price,
        time: trade.ts,
      });
      await publish({
        eventId,
        userId: alert.accountId,
        strategyId: strategy.id,
        strategyVersion: version.version,
        runId: view.runId,
        alertId: alert.id,
        mode: 'paper',
        symbol: view.symbol,
        side: trade.side,
        qty: trade.qty,
        price: trade.price,
        filledAt: trade.ts,
        message: message.slice(0, 600),
        channels,
      });
      await deps.notify.markAnnounced({ alertId: alert.id, runId: view.runId, seq, eventId });
      published += 1;
    }
  }
  return published;
}
