'use client';

import { SWITCH_EXPLAINERS, TRADE_ALWAYS_ALLOWED, type SwitchExplainer } from '@/lib/trade-ops/kill-switch-model';

/** What each switch does and does not do, so an operator never reaches for the wrong one (TRD-0193). */
export function KillSwitchExplainer() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {SWITCH_EXPLAINERS.map((r: SwitchExplainer) => (
          <section key={r.name} className="rounded-md border border-line p-3 text-sm">
            <h3 className="font-medium text-fg">{r.name}</h3>
            <p className="mt-1 text-fg-2">
              <span className="text-fg-3">Stops: </span>
              {r.stops}
            </p>
            <p className="mt-1 text-fg-2">
              <span className="text-fg-3">Does not: </span>
              {r.doesNotStop}
            </p>
          </section>
        ))}
      </div>
      <div className="text-sm text-fg-2">
        <p className="font-medium text-fg">While the trade module is stopped, the edge still lets these through</p>
        <ul className="mt-1 list-disc pl-5">
          {TRADE_ALWAYS_ALLOWED.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="mt-2">
          Everything else that commits a new order is refused with <code className="if-num text-xs">edge.module_killed</code> (503,
          retry-after 30).
        </p>
      </div>
    </div>
  );
}
