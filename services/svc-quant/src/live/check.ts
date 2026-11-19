import type { QuantLiveOrderType, QuantSignalRules } from '@intafaced/contracts';

/**
 * The deploy wizard's compile check (AL-live-02; J-algo-dev-06 #6): every order one stored version would place on a live
 * deploy, and whether the live runner can place it. The runner (svc-trade `src/quant/live-run/live-runs.ts`) trades a
 * version's order blocks as market orders and refuses a version of signal rules (`quant.live_plan_unsupported`); it has
 * no stop or take-profit order, so a version's stop loss or take profit is refused here as `trade.order_type_unsupported`
 * rather than dropped quietly. Pure: reads the version as stored and writes nothing.
 */
export interface LiveCheckVersion {
  readonly blocks: ReadonlyArray<{ readonly side: 'buy' | 'sell'; readonly symbol: string; readonly qty: string }>;
  readonly modules: QuantSignalRules | null;
}

export interface LiveCheckReading {
  readonly plan: 'blocks' | 'signal';
  readonly orderTypes: QuantLiveOrderType[];
  readonly compiles: boolean;
}

const set = (raw: string | undefined) => (raw ?? '').trim();

export function liveCheck(version: LiveCheckVersion): LiveCheckReading {
  const orderTypes: QuantLiveOrderType[] = [];
  const rules = version.modules;
  if (rules) {
    orderTypes.push({
      source: 'signal_entry',
      block: null,
      type: 'market',
      percent: null,
      supported: false,
      code: 'quant.live_plan_unsupported',
    });
    const stop = set(rules.exit.stopLossPercent);
    if (stop) {
      orderTypes.push({
        source: 'stop_loss',
        block: null,
        type: 'stop',
        percent: stop,
        supported: false,
        code: 'trade.order_type_unsupported',
      });
    }
    const take = set(rules.exit.takeProfitPercent);
    if (take) {
      orderTypes.push({
        source: 'take_profit',
        block: null,
        type: 'take_profit',
        percent: take,
        supported: false,
        code: 'trade.order_type_unsupported',
      });
    }
  } else {
    version.blocks.forEach((_, i) => {
      orderTypes.push({ source: 'block', block: i + 1, type: 'market', percent: null, supported: true, code: null });
    });
  }
  const compiles = orderTypes.length > 0 && orderTypes.every((row) => row.supported);
  return { plan: rules ? 'signal' : 'blocks', orderTypes, compiles };
}
