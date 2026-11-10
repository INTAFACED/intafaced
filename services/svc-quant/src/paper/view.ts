import type { QuantPaperRun, QuantSignalRules } from '@intafaced/contracts';
import { barSpanMs, type BarSize } from '../engine/bars.js';
import type { FeePort, HistoryPort } from '../engine/ports.js';
import { prepareBacktest, runOnBars } from '../engine/run.js';
import { QUANT_BACKTEST_RULES_REQUIRED, QUANT_COST_UNSET, QUANT_PAPER_CASH_UNSET, QuantError } from '../errors.js';
import type { StoredPaperRun } from '../runs/types.js';
import { compileSignalRules } from '../studio/modules.js';

export const PAPER_KEY_PREFIX = 'algo:paper:';

/** The derived key of a paper start (AL-live-01): the version's run count the start dialog read is the ordinal. */
export function paperKey(strategyId: string, version: number, ordinal: number): string {
  return `${PAPER_KEY_PREFIX}${strategyId}:v${version}:${ordinal}`;
}

const DECIMAL = /^\d{1,18}(\.\d{1,18})?$/;
const isZero = (text: string) => /^0+(\.0+)?$/.test(text);

/** The version a paper run runs, as the view needs it. */
export interface PaperVersion {
  readonly id: string;
  readonly version: number;
  readonly modules: QuantSignalRules | null;
  readonly risk: { readonly maxDrawdown: string; readonly maxNotional: string; readonly kill: string };
}

/**
 * What a paper run did, derived on this read from the exchange's own closed candles between its start and now (or its
 * stop), by the bar engine with the run's own cash and costs. A signal fills at the open of the next bar that trades
 * (ENGINE BT-2), so a fill always uses a price from after the start: before the first closed bar there is no fill, and
 * no earlier price is ever carried over.
 */
export async function paperView(
  paper: StoredPaperRun,
  strategy: PaperVersion,
  ports: { readonly fees: FeePort; readonly history: HistoryPort },
  nowMs: number,
): Promise<QuantPaperRun> {
  const { run, settings } = paper;
  if (!strategy.modules) throw new QuantError(QUANT_BACKTEST_RULES_REQUIRED, 'a paper run runs signal rules');
  const rules = compileSignalRules(strategy.modules).rules;
  const barSize = rules.barSize as BarSize;
  const span = barSpanMs(barSize);
  const startMs = Date.parse(run.started);
  const endMs = run.finished ? Math.min(Date.parse(run.finished), nowMs) : nowMs;
  const base = {
    runId: run.id,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    state: run.finished ? ('stopped' as const) : ('running' as const),
    startedAt: run.started,
    stoppedAt: run.finished,
    cash: settings.cash,
    feed: settings.feed,
    holdings: settings.holdings.map((row) => ({ ...row })),
    costs: { feeRole: settings.feeRole, slippageBps: settings.slippageBps, delayBars: settings.delayBars },
    symbol: rules.symbol,
    barSize,
    simulated: true as const,
    live: false as const,
    claimLabel: 'Paper — not live performance' as const,
  };
  const unpriced = {
    ...base,
    priced: false,
    pricedThrough: null,
    trades: [],
    equity: [],
    position: { symbol: rules.symbol, qty: '0' },
    totals: { startCash: settings.cash, fees: '0', net: '0', endEquity: settings.cash },
  };
  // No whole bar has closed since the start: nothing has a price yet, so nothing has filled.
  if (Math.floor(endMs / span) * span - Math.ceil(startMs / span) * span < span) return unpriced;
  const bars = await ports.history.bars({ symbol: rules.symbol, barSize, fromMs: Math.ceil(startMs / span) * span, toMs: endMs });
  if (bars.length === 0) return unpriced;
  const last = bars[bars.length - 1]!;
  const pricedThrough = new Date(last.openTimeMs + span).toISOString();
  // A start of 0 cash is deliberate: priced, but nothing can be bought with it.
  if (isZero(settings.cash)) return { ...unpriced, priced: true, pricedThrough };
  const prepared = await prepareBacktest(
    {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      cash: settings.cash,
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      fillTiming: 'next_open',
      costs: { feeRole: settings.feeRole, slippageBps: settings.slippageBps, delayBars: String(settings.delayBars) },
    },
    { id: strategy.id, version: strategy.version, modules: strategy.modules, risk: strategy.risk },
    ports.fees,
    nowMs,
  );
  const ran = runOnBars(prepared, bars);
  return {
    ...base,
    priced: true,
    pricedThrough,
    trades: ran.trades.map((trade) => ({ ...trade })),
    equity: ran.equity.map((point) => ({ ts: point.ts, equity: point.equity })),
    position: { symbol: rules.symbol, qty: ran.totals.openQty },
    totals: { startCash: ran.totals.startCash, fees: ran.totals.fees, net: ran.totals.net, endEquity: ran.totals.endEquity },
  };
}

/** A paper start's settings, checked by name; nothing is assumed. */
export function paperSettingsOf(input: {
  readonly cash: string;
  readonly holdings: readonly { readonly symbol: string; readonly qty: string }[];
  readonly costs: { readonly feeRole: string; readonly slippageBps: string; readonly delayBars: string };
}) {
  const cash = input.cash.trim();
  if (!cash) throw new QuantError(QUANT_PAPER_CASH_UNSET, 'cash — starting cash is unset; no amount is assumed');
  if (!DECIMAL.test(cash)) throw new QuantError(QUANT_PAPER_CASH_UNSET, 'cash — starting cash must be an amount of 0 or more');
  if (input.holdings.length > 0) {
    throw new QuantError(
      'quant.params_invalid',
      'holdings — a paper run starts from cash only in this build; leave the holdings list empty',
    );
  }
  const feeRole = input.costs.feeRole.trim();
  if (feeRole !== 'taker' && feeRole !== 'maker') {
    throw new QuantError(QUANT_COST_UNSET, 'fees — choose the taker or maker rate of the published schedule');
  }
  const slippageBps = input.costs.slippageBps.trim();
  if (!slippageBps) throw new QuantError(QUANT_COST_UNSET, 'slippage — fill in slippage in basis points; it is never assumed to be 0');
  if (!DECIMAL.test(slippageBps) || Number(slippageBps) >= 10_000) {
    throw new QuantError(QUANT_COST_UNSET, 'slippage — must be basis points from 0 up to, not including, 10000');
  }
  const delay = input.costs.delayBars.trim();
  if (!delay) throw new QuantError(QUANT_COST_UNSET, 'delay — fill in the delay in whole bars; it is never assumed to be 0');
  if (!/^\d{1,3}$/.test(delay) || Number(delay) > 100)
    throw new QuantError(QUANT_COST_UNSET, 'delay — must be a whole number of bars from 0 to 100');
  return {
    cash,
    holdings: [] as { symbol: string; qty: string }[],
    feed: 'own_venue' as const,
    feeRole,
    slippageBps,
    delayBars: Number(delay),
  } as const;
}
