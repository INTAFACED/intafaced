import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { MATCHING_OPERATIONS, type MatchingHealth, type MatchingOperation, type OperationReading } from '@/lib/trade-ops/matching-edge';

/**
 * The engine's figures on the Venue / matching tile (J-cex-spot-20 #1), each as the engine gave it through svc-edge. A figure
 * the answer did not carry, and a latency the engine has not timed since it started, shows the typed blocker
 * `matching_metrics_unread` and no number, never a zero.
 */

const UNREAD = BLOCKERS.matching_metrics_unread;
const LABEL: Record<MatchingOperation, string> = {
  submit: 'Single-order submit latency',
  cancel: 'Single-order cancel latency',
  depth: 'Depth read latency',
};

function Unread({ metric, label, why }: { metric: string; label: string; why: string }) {
  return (
    <span data-metric={metric} data-state="unread" className="block">
      {label}: not read · <span className="if-num">{UNREAD.key}</span> ({why})
    </span>
  );
}

const ms = (v: number | null) => (v === null ? 'slower than the engine’s last bucket' : `≤ ${v} ms`);

function Latency({ op, reading, startedAt }: { op: MatchingOperation; reading: OperationReading | null; startedAt: string | null }) {
  const metric = `latency-${op}`;
  if (!reading) return <Unread metric={metric} label={LABEL[op]} why="the engine's answer did not carry it" />;
  if (reading.count === 0) {
    return (
      <Unread
        metric={metric}
        label={LABEL[op]}
        why={startedAt ? `nothing timed since the engine started at ${startedAt}` : 'nothing timed since the engine started'}
      />
    );
  }
  return (
    <span data-metric={metric} data-state="read" data-count={reading.count} className="block">
      {LABEL[op]}: p50 {ms(reading.p50Ms)} · p99 {ms(reading.p99Ms)} · {reading.count} timed ({reading.perMinute}/min on average since
      timing began
      {reading.errors > 0 ? `, ${reading.errors} failed` : ''})
    </span>
  );
}

/** Submit latency per engine market, named by its symbol where the catalogue has it. */
function MarketLatency({ h, symbols }: { h: MatchingHealth; symbols: ReadonlyMap<string, string> }) {
  if (h.submitByMarket === null) {
    return <Unread metric="latency-submit-markets" label="Submit latency by market" why="the engine's answer did not carry it" />;
  }
  // Every catalogue market, plus any market the engine has that the catalogue read did not return. A market the engine
  // has timed no submit for since it started (or has no book for) is not read: the typed blocker, never 0 ms.
  const byMarket = h.submitByMarket;
  const ids = new Set<string>([...symbols.keys(), ...Object.keys(byMarket)]);
  const rows = [...ids]
    .map((id) => ({ id, symbol: symbols.get(id) ?? id, reading: byMarket[id] ?? null }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return (
    <span className="block">
      Submit latency by market:
      {rows.map(({ id, symbol, reading }) =>
        reading === null || reading.count === 0 ? (
          <span
            key={id}
            data-metric="latency-submit-market"
            data-market-id={id}
            data-market-symbol={symbol}
            data-state="unread"
            className="block ps-2"
          >
            {symbol}: not read · <span className="if-num">{UNREAD.key}</span> (nothing timed since the engine started)
          </span>
        ) : (
          <span
            key={id}
            data-metric="latency-submit-market"
            data-market-id={id}
            data-market-symbol={symbol}
            data-state="read"
            data-count={reading.count}
            className="block ps-2"
          >
            {symbol}: p50 {ms(reading.p50Ms)} · p99 {ms(reading.p99Ms)} · {reading.count} timed
          </span>
        ),
      )}
    </span>
  );
}

export function venueLines(h: MatchingHealth, symbols: ReadonlyMap<string, string> = new Map()) {
  return [
    <span key="halt" className="block">
      Venue: <span data-metric="venue-halted">{h.venueHalted ? 'Halted' : 'Running'}</span>
      {h.venueHalted ? ' (halt-all is on: no market accepts new orders)' : ' (halt-all is off)'}
    </span>,
    h.markets === null ? (
      <Unread key="markets" metric="markets" label="Markets on the engine" why="the engine's answer did not carry it" />
    ) : (
      <span key="markets" data-metric="markets" data-value={h.markets} className="block">
        Markets on the engine: {h.markets}
      </span>
    ),
    <span key="resting" data-metric="resting-orders" data-value={h.restingOrders} className="block">
      {h.restingOrders} resting orders · {h.journalRecords} journal records
    </span>,
    h.admission === null ? (
      <Unread key="admission" metric="admission" label="Admission" why="the engine's answer did not carry it" />
    ) : (
      <span key="admission" className="block">
        Admission: <span data-metric="admission">{h.admission.open ? 'Open' : `Closed: ${h.admission.reason ?? 'no reason given'}`}</span>
      </span>
    ),
    h.holdHalted === null ? (
      <Unread key="hold" metric="hold-halted" label="Markets halted for an unread hold" why="the engine's answer did not carry it" />
    ) : (
      <span key="hold" data-metric="hold-halted" data-value={h.holdHalted.join(',')} className="block">
        Markets halted for an unread hold: {h.holdHalted.length === 0 ? 'none' : h.holdHalted.join(', ')}
      </span>
    ),
    h.engineStartedAt === null ? (
      <Unread key="started" metric="engine-started" label="Latency counted since" why="the engine's answer did not carry it" />
    ) : (
      <span key="started" data-metric="engine-started" data-value={h.engineStartedAt} className="block">
        Latency counted since {h.engineStartedAt} (this engine process)
      </span>
    ),
    ...MATCHING_OPERATIONS.map((op) => <Latency key={op} op={op} reading={h.operations[op]} startedAt={h.engineStartedAt} />),
    <MarketLatency key="by-market" h={h} symbols={symbols} />,
    <span key="scope" className="block">
      Mass quote, mass cancel and spread orders are timed in the engine’s scrape only, not here.
    </span>,
    <span key="age" className="block">
      Read through svc-edge in {h.ageMs} ms.
    </span>,
  ];
}
