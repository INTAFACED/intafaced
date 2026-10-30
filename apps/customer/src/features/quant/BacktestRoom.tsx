import {
  QUANT_FEE_ROLES,
  quantAccountRulesSchema,
  QUANT_FILL_TIMINGS,
  QUANT_SPLIT_PRESETS,
  QUANT_VERDICT_CRITERIA,
  quantOutOfSampleFrom,
  quantBacktestFeeSchema,
  quantBacktestResultSchema,
  quantStrategyHeadSchema,
  quantStrategyListOutputSchema,
  type QuantBacktestMetrics,
  type QuantBacktestResult,
  type QuantCheck,
  type QuantMetric,
  type QuantShareCreated,
  type QuantSplitPreset,
  type QuantStrategyHead,
} from '@intafaced/contracts/quant-algo';
import { DATAFEED_INTERVAL_MS } from '@intafaced/contracts/datafeed';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel, Tabs } from '../../shared/ui';
import { downloadCsv } from '../more/depth-csv';
import { utcInput } from '../more/quant-analysis';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { equityGeometry, tradesCsv, tradesCsvName } from './backtest-chart';
import { backtestCopy } from './backtest-copy';
import { ReportTab, ShareTab, type CreatedShare } from './ReportShare';
import { ChecksTab, LogText, MetricsTab } from './result-figures';
import { reportCopy } from './report-copy';
import { RunHistory } from './RunHistory';
import './algo.css';
import { STRATEGY_PAGE } from './StrategyTable';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const page = quantStrategyListOutputSchema.extend({ strategies: z.array(quantStrategyHeadSchema) });

/** The inputs a refusal can name, by the word the service puts first in its message. */
const NAMED = { cash: 'cash', fees: 'feeRole', slippage: 'slippage', delay: 'delay', from: 'from', to: 'to' } as const;
type Named = (typeof NAMED)[keyof typeof NAMED] | 'fillTiming' | 'split' | 'oosFrom' | 'holdout' | 'leverage' | 'accountRule';
type Refusal = { input: Named; detail: string; blank: boolean };

/**
 * `quant.cost_unset — slippage — …`, `quant.cash_unset — cash — …`, `quant.backtest_window_invalid — from …` and
 * `quant.fill_timing_unset — …` each name one input; anything else is shown whole.
 */
function namedRefusal(message: string): Refusal | null {
  const blank = (detail: string) => /unset|fill in|choose/i.test(detail);
  const cost = /^quant\.(?:cost_unset|cash_unset) — (cash|fees|slippage|delay) (?:— )?(.*)$/.exec(message);
  if (cost) return { input: NAMED[cost[1] as keyof typeof NAMED], detail: cost[2]!.trim(), blank: blank(cost[2]!) };
  const window = /^quant\.backtest_window_(?:invalid|open) — (from|to) (.*)$/.exec(message);
  if (window) return { input: NAMED[window[1] as 'from' | 'to'], detail: window[2]!.trim(), blank: false };
  const timing = /^quant\.fill_timing_unset — (.*)$/.exec(message);
  if (timing) return { input: 'fillTiming', detail: timing[1]!.trim(), blank: blank(timing[1]!) };
  const split = /^quant\.backtest_window_invalid — (split — |out-of-sample start )(.*)$/.exec(message);
  if (split) return { input: split[1]!.startsWith('split') ? 'split' : 'oosFrom', detail: split[2]!.trim(), blank: false };
  const account = /^quant\.account_rule_unset — (leverage|maximum leverage|margin call level|stop-out level) — (.*)$/.exec(message);
  if (account) {
    const own = account[1] === 'leverage';
    return {
      input: own ? 'leverage' : 'accountRule',
      detail: own ? account[2]!.trim() : message.split(' — ').slice(1).join(' — '),
      blank: own && blank(account[2]!),
    };
  }
  const holdout = /^quant\.holdout_(?:overlap|date_unset) — holdout — (.*)$/.exec(message);
  if (holdout) return { input: 'holdout', detail: holdout[1]!.trim(), blank: false };
  return null;
}

/**
 * The bar backtest (AL-backtest-01, AL-backtest-02): a saved signal-rules strategy, a window, starting cash and the
 * costs, run on the exchange's own closed bars. Run sends the same inputs every time, so a press after a lost reply
 * reads back the stored run rather than starting a second one. A blank cost refuses by name next to its field.
 */
export function BacktestRoom() {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const list = useResource(
    (signal) => api.query('quant', 'studio.list', { limit: STRATEGY_PAGE }, page, { signal }),
    'quant-backtest-strategies',
  );
  const [strategyId, setStrategyId] = useState('');
  const [cash, setCash] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fillTiming, setFillTiming] = useState('');
  const [feeRole, setFeeRole] = useState('');
  const [slippage, setSlippage] = useState('');
  const [delay, setDelay] = useState('');
  const [split, setSplit] = useState<QuantSplitPreset | ''>('');
  const [oosFrom, setOosFrom] = useState('');
  const [enforceHoldout, setEnforceHoldout] = useState(false);
  const [onMargin, setOnMargin] = useState(false);
  const [leverage, setLeverage] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [result, setResult] = useState<QuantBacktestResult | null>(null);

  const labels: Record<Named, string> = {
    cash: t('cash'),
    feeRole: t('feeRole'),
    slippage: t('slippage'),
    delay: t('delay'),
    from: t('from'),
    to: t('to'),
    fillTiming: t('fillTiming'),
    split: t('split'),
    oosFrom: t('oosFrom'),
    holdout: t('holdout'),
    leverage: t('leverage'),
    accountRule: t('accountRule'),
  };
  // A refusal shows once, next to the input it names.
  const errorFor = (input: Named): ReactNode =>
    refusal?.input === input ? (
      <span role="alert" data-testid="quant-backtest-refusal">
        {refusal.blank ? t('unset', { input: labels[input] }) : t('invalid', { input: labels[input], detail: refusal.detail })}
      </span>
    ) : undefined;
  const selectError = (input: Named) => refusal?.input === input && <p className="error-text">{errorFor(input)}</p>;
  // Any change to an input makes the shown result and refusal stale, so both go.
  const edited =
    <V,>(set: (value: V) => void) =>
    (value: V) => {
      set(value);
      setResult(null);
      setRefusal(null);
      setFailure(null);
    };

  async function run(strategy: QuantStrategyHead) {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    const res = await api.mutate(
      'quant',
      'backtest.start',
      {
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        cash,
        // A field the browser cannot read as a UTC minute is sent as typed, and the service names it.
        from: utcInput(from) ?? from,
        to: utcInput(to) ?? to,
        fillTiming,
        costs: { feeRole, slippageBps: slippage, delayBars: delay },
        ...(split ? { split: { preset: split, ...(split === 'custom' ? { outOfSampleFrom: utcInput(oosFrom) ?? oosFrom } : {}) } } : {}),
        ...(enforceHoldout ? { enforceHoldout: true } : {}),
        ...(onMargin ? { simulatedAccount: { leverage } } : {}),
      },
      quantBacktestResultSchema,
    );
    setBusy(false);
    if (res.ok) {
      setResult(res.data);
      return;
    }
    const named = namedRefusal(res.message);
    if (named) setRefusal(named);
    else setFailure(res);
  }

  return (
    <>
      <Panel title={t('title')}>
        <div data-testid="quant-bar-backtest">
          <p className="muted">{t('intro')}</p>
          <Read resource={list.resource} retry={list.reload}>
            {(data) => {
              if (!data.strategies.length) {
                return (
                  <EmptyState title={t('strategyNone')}>
                    {t('strategyNoneBody')}{' '}
                    <a className="text-link" href="/quant/studio">
                      {t('openStudio')}
                    </a>
                  </EmptyState>
                );
              }
              const strategy = data.strategies.find((row) => row.id === strategyId) ?? null;
              return (
                <form
                  className="quant-bar-backtest"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (strategy) void run(strategy);
                  }}
                >
                  <Select
                    label={t('strategy')}
                    value={strategyId}
                    onChange={(id) => {
                      setStrategyId(id);
                      setResult(null);
                      setRefusal(null);
                      setFailure(null);
                      // The saved starting cash is the person's own figure; they may change it for this run.
                      setCash(data.strategies.find((row) => row.id === id)?.cash ?? '');
                    }}
                    options={[
                      { value: '', label: t('strategyChoose') },
                      ...data.strategies.map((row) => ({ value: row.id, label: row.name })),
                    ]}
                  />
                  {strategy && (
                    <p className="muted" data-testid="quant-backtest-rules">
                      {strategy.modules
                        ? t('rulesOf', { version: strategy.version, symbol: strategy.modules.symbol, barSize: strategy.modules.barSize })
                        : t('blocksOnly', { version: strategy.version })}
                    </p>
                  )}
                  {strategy?.modules && <FeeLedger symbol={strategy.modules.symbol} />}
                  <Field
                    label={t('cash')}
                    value={cash}
                    onChange={(e) => edited(setCash)(e.target.value)}
                    inputMode="decimal"
                    maxLength={40}
                    error={errorFor('cash')}
                  />
                  <div className="quant-date-fields">
                    <Field
                      label={t('from')}
                      type="datetime-local"
                      value={from}
                      onChange={(e) => edited(setFrom)(e.target.value)}
                      error={errorFor('from')}
                    />
                    <Field
                      label={t('to')}
                      type="datetime-local"
                      value={to}
                      onChange={(e) => edited(setTo)(e.target.value)}
                      error={errorFor('to')}
                    />
                  </div>
                  <Select
                    label={t('split')}
                    value={split}
                    onChange={(value) => edited(setSplit)(value as QuantSplitPreset | '')}
                    options={[
                      { value: '', label: t('splitNone') },
                      ...QUANT_SPLIT_PRESETS.map((value) => ({ value, label: t(SPLIT_WORDS[value]) })),
                    ]}
                  />
                  {split === 'custom' && (
                    <Field
                      label={t('oosFrom')}
                      type="datetime-local"
                      value={oosFrom}
                      onChange={(e) => edited(setOosFrom)(e.target.value)}
                      error={errorFor('oosFrom')}
                    />
                  )}
                  {split && strategy?.modules && (
                    <SplitPreview from={from} to={to} preset={split} oosFrom={oosFrom} barSize={strategy.modules.barSize} />
                  )}
                  {selectError('split')}
                  <label className="quant-check-line">
                    <input
                      type="checkbox"
                      className="quant-run-check"
                      checked={enforceHoldout}
                      onChange={(e) => edited(setEnforceHoldout)(e.target.checked)}
                    />
                    {t('holdout')}
                  </label>
                  {selectError('holdout')}
                  <fieldset className="quant-account" data-testid="quant-account">
                    <legend>{t('accountTitle')}</legend>
                    <label className="quant-check-line">
                      <input
                        type="checkbox"
                        className="quant-run-check"
                        checked={onMargin}
                        onChange={(e) => edited(setOnMargin)(e.target.checked)}
                      />
                      {t('onMargin')}
                    </label>
                    {onMargin ? (
                      <>
                        <Field
                          label={t('leverage')}
                          value={leverage}
                          onChange={(e) => edited(setLeverage)(e.target.value)}
                          inputMode="decimal"
                          maxLength={8}
                          error={errorFor('leverage')}
                        />
                        <AccountRules />
                        {selectError('accountRule')}
                      </>
                    ) : (
                      <p className="muted">{t('cashAccount')}</p>
                    )}
                  </fieldset>
                  <Select
                    label={t('fillTiming')}
                    value={fillTiming}
                    onChange={edited(setFillTiming)}
                    options={[{ value: '', label: t('fillChoose') }, ...QUANT_FILL_TIMINGS.map((value) => ({ value, label: t(value) }))]}
                  />
                  {selectError('fillTiming')}
                  <Select
                    label={t('feeRole')}
                    value={feeRole}
                    onChange={edited(setFeeRole)}
                    options={[{ value: '', label: t('feeChoose') }, ...QUANT_FEE_ROLES.map((value) => ({ value, label: t(value) }))]}
                  />
                  {selectError('feeRole')}
                  <Field
                    label={t('slippage')}
                    value={slippage}
                    onChange={(e) => edited(setSlippage)(e.target.value)}
                    inputMode="decimal"
                    maxLength={24}
                    error={errorFor('slippage')}
                  />
                  <Field
                    label={t('delay')}
                    value={delay}
                    onChange={(e) => edited(setDelay)(e.target.value)}
                    inputMode="numeric"
                    maxLength={3}
                    error={errorFor('delay')}
                  />
                  <Button type="submit" disabled={busy || !strategy} data-testid="quant-backtest-run">
                    {t('run')}
                  </Button>
                  {busy && <Loading label={t('running')} />}
                  {failure && <Failure result={failure} retry={() => strategy && void run(strategy)} />}
                </form>
              );
            }}
          </Read>
          {result && <BacktestResult key={result.runId} result={result} />}
        </div>
      </Panel>
      {/* A new result refreshes the list, so the run just stored is at the top. */}
      <RunHistory refresh={result?.runId ?? ''} onOpen={setResult} />
    </>
  );
}

/** An ISO instant as its UTC minute, "2026-10-23 03:40". */
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

const SPLIT_WORDS = { '1/2': 'split_half', '1/3': 'split_third', '1/4': 'split_quarter', custom: 'split_custom' } as const;

/** Both parts of the split as the service will cut them, shown before Run: the same rule, on the strategy's bar size. */
function SplitPreview(props: { from: string; to: string; preset: QuantSplitPreset; oosFrom: string; barSize: string }) {
  const { t } = backtestCopy.useCopy();
  const at = (value: string) => Date.parse(utcInput(value) ?? '');
  const span = DATAFEED_INTERVAL_MS[props.barSize as keyof typeof DATAFEED_INTERVAL_MS];
  const fromMs = at(props.from);
  const toMs = at(props.to);
  const custom = props.preset === 'custom' ? at(props.oosFrom) : undefined;
  const cut =
    Number.isFinite(fromMs) && Number.isFinite(toMs) && span ? quantOutOfSampleFrom({ fromMs, toMs }, props.preset, span, custom) : null;
  if (cut === null)
    return (
      <p className="muted" data-testid="quant-split-preview">
        {t('splitShort')}
      </p>
    );
  const minute = (ms: number) => utcText(new Date(ms).toISOString());
  return (
    <p data-testid="quant-split-preview" data-oos-from={new Date(cut).toISOString()}>
      {t('splitPreview', { isFrom: minute(fromMs), isTo: minute(cut), oosFrom: minute(cut), oosTo: minute(toMs) })}
    </p>
  );
}

/** The owner's published margin rules, read only; a blank one reads "not set" and a margin run refuses it by name. */
function AccountRules() {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const rules = useResource(
    (signal) => api.query('quant', 'backtest.accountRules', undefined, quantAccountRulesSchema, { signal }),
    'quant-account-rules',
  );
  return (
    <Read resource={rules.resource} retry={rules.reload}>
      {(data) => (
        <div data-testid="quant-account-rules">
          <p className="muted">{t('accountRulesIntro')}</p>
          <dl className="quant-bar-totals">
            {(['maxLeverage', 'marginCallPercent', 'stopOutPercent'] as const).map((name) => (
              <div key={name} data-rule={name} data-value={data[name] ?? ''}>
                <dt>{t(`rule_${name}`)}</dt>
                <dd lang={data[name] === null ? undefined : 'zxx'}>{data[name] ?? t('notSet')}</dd>
              </div>
            ))}
          </dl>
          <p>{t('accountMode')}</p>
        </div>
      )}
    </Read>
  );
}

/** The published rates for the strategy's symbol, read before the run so the person sees what will be charged. */
function FeeLedger({ symbol }: { symbol: string }) {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const fee = useResource(
    (signal) => api.query('quant', 'backtest.fee', { symbol }, quantBacktestFeeSchema, { signal }),
    `quant-fee:${symbol}`,
  );
  return (
    <div data-testid="quant-fee-ledger">
      <Read resource={fee.resource} retry={fee.reload}>
        {(data) => <p>{t('feeLedger', { version: data.version, symbol: data.symbol, taker: data.takerBps, maker: data.makerBps })}</p>}
      </Read>
    </div>
  );
}

const RESULT_TABS = ['summary', 'metrics', 'checks', 'charts', 'trades', 'log', 'report', 'share'] as const;
const CHART_W = 1000;
const CHART_H = 300;
type ResultTab = (typeof RESULT_TABS)[number];

function BacktestResult({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const [tab, setTab] = useState<ResultTab>('summary');
  // A share link's address is shown once; held here, it survives a look at another tab.
  const created: CreatedShare = useState<QuantShareCreated | null>(null);
  return (
    <section aria-label={t('resultTitle')} data-testid="quant-bar-result" data-run-id={result.runId}>
      <h3>{t('resultTitle')}</h3>
      <p className="muted">{t('simulated')}</p>
      <VerdictCard result={result} />
      <Tabs
        items={RESULT_TABS}
        value={tab}
        onChange={(next) => setTab(next as ResultTab)}
        label={t('resultTabs')}
        labels={{
          summary: t('tabSummary'),
          metrics: t('tabMetrics'),
          checks: t('tabChecks'),
          charts: t('tabCharts'),
          trades: t('tabTrades'),
          log: t('tabLog'),
          report: reportCopy.t('tabReport'),
          share: reportCopy.t('tabShare'),
        }}
      />
      {tab === 'summary' && <ResultSummary result={result} />}
      {tab === 'metrics' && <MetricsTab metrics={result.metrics} />}
      {tab === 'checks' && <ChecksTab checks={result.checks} />}
      {tab === 'charts' && <ResultCharts result={result} />}
      {tab === 'trades' && <ResultTrades result={result} />}
      {tab === 'log' && <ResultLog result={result} />}
      {tab === 'report' && <ReportTab runId={result.runId} />}
      {tab === 'share' && <ShareTab runId={result.runId} created={created} />}
    </section>
  );
}

const WHY = [
  'not_split',
  'criteria_unset',
  'too_few_trades',
  'section_undefined',
  'return_below_minimum',
  'drawdown_above_maximum',
  'shortfall_above_maximum',
] as const;

/**
 * The verdict the service computed (AL-backtest-04), with its reasons in words, every criterion as it stood (a blank one
 * named "not set"), the variant count, whether the holdout was enforced, and any field the request sent that only the
 * service sets.
 */
function VerdictCard({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const { verdict, sections } = result;
  const why = (reason: string) => ((WHY as readonly string[]).includes(reason) ? t(`why_${reason as (typeof WHY)[number]}`) : reason);
  const percent = (metric: QuantMetric) => metric.value ?? t('notSet');
  return (
    <section aria-label={t('verdictTitle')} data-testid="quant-verdict" data-status={verdict.status}>
      <h4>{t('verdictTitle')}</h4>
      <p data-testid="quant-verdict-status">
        <strong>{t(`v_${verdict.status}`)}</strong>
      </p>
      <p className="muted">{t('verdictComputed')}</p>
      <ul data-testid="quant-verdict-reasons">
        {verdict.reasons.map((reason) => (
          <li key={reason} data-reason={reason}>
            {why(reason)}
          </li>
        ))}
      </ul>
      {verdict.unset.length > 0 && (
        <p role="note" data-testid="quant-verdict-unset" data-unset={verdict.unset.join(',')}>
          {t('unsetNamed', { names: verdict.unset.map((name) => t(`c_${name}`)).join(', ') })}
        </p>
      )}
      <h5>{t('criteriaTitle')}</h5>
      <dl className="quant-bar-totals" data-testid="quant-verdict-criteria">
        {QUANT_VERDICT_CRITERIA.map((name) => (
          <div key={name} data-criterion={name} data-value={verdict.criteria[name] ?? ''}>
            <dt>{t(`c_${name}`)}</dt>
            <dd lang={verdict.criteria[name] === null ? undefined : 'zxx'}>{verdict.criteria[name] ?? t('notSet')}</dd>
          </div>
        ))}
      </dl>
      <p data-testid="quant-variant-count" data-count={result.variantCount ?? ''}>
        {result.variantCount === null ? t('variantsNone') : t('variants', { count: result.variantCount })}
      </p>
      <p className="muted">{t('variantsHelp')}</p>
      <p data-testid="quant-holdout" data-enforced={String(result.holdout.enforced)}>
        {result.holdout.enforced && result.holdout.from ? t('holdoutOn', { from: utcText(result.holdout.from) }) : t('holdoutOff')}
      </p>
      {result.ignoredInputs.length > 0 && (
        <p role="note" data-testid="quant-ignored-inputs" data-fields={result.ignoredInputs.join(',')}>
          {t('ignored', { fields: result.ignoredInputs.join(', ') })}
        </p>
      )}
      {sections && (
        <DataTable headers={[t('part'), t('partWindow'), t('partReturn'), t('partDrawdown'), t('partTrips')]} label={t('sectionsTitle')}>
          {(
            [
              ['inSample', sections.inSample],
              ['outOfSample', sections.outOfSample],
            ] as const
          ).map(([name, part]) => (
            <tr key={name} data-testid={`quant-section-${name}`} data-from={part.from} data-to={part.to}>
              <td>{t(name)}</td>
              <td lang="zxx">
                {utcText(part.from)} – {utcText(part.to)}
              </td>
              <td lang="zxx">{percent(part.returnPercent)}</td>
              <td lang="zxx">{percent(part.maxDrawdownPercent)}</td>
              <td lang="zxx">{part.roundTrips}</td>
            </tr>
          ))}
        </DataTable>
      )}
      {sections && <p data-testid="quant-sections-note">{t('sectionsNote')}</p>}
    </section>
  );
}

function ResultSummary({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const { totals, coverage } = result;
  return (
    <>
      <h4>{t('assumptionsTitle')}</h4>
      <ul data-testid="quant-bar-assumptions">
        {result.assumptions.map((name) => (
          <li key={name} data-assumption={name}>
            {t(name)}
          </li>
        ))}
      </ul>
      <p data-testid="quant-bar-account" data-leverage={result.account?.leverage ?? ''}>
        {result.account
          ? t('marginAccount', {
              leverage: result.account.leverage,
              call: result.account.marginCallPercent ?? '',
              stopOut: result.account.stopOutPercent ?? '',
            })
          : t('cashAccount')}
      </p>
      <p lang="zxx" data-testid="quant-bar-run-id">
        {t('runId', { id: result.runId })}
      </p>
      <p data-testid="quant-bar-coverage">{t('coverage', { bars: coverage.bars, expected: coverage.expected })}</p>
      {coverage.gaps.length ? (
        <DataTable headers={[t('gapsTitle')]} label={t('gapsTitle')}>
          {coverage.gaps.map((gap) => (
            <tr key={gap.from} data-testid="quant-bar-gap" data-from={gap.from} data-to={gap.to}>
              <td lang="zxx">{t('gap', { from: utcText(gap.from), to: utcText(gap.to) })}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="muted">{t('gapsNone')}</p>
      )}
      <dl className="quant-bar-totals" data-testid="quant-bar-totals">
        {(
          [
            ['gross', totals.gross],
            ['fees', totals.fees],
            ['slippageTotal', totals.slippage],
            ['net', totals.net],
            ['endEquity', totals.endEquity],
            ['openQty', totals.openQty],
          ] as const
        ).map(([key, value]) => (
          <div key={key} data-testid={`quant-bar-total-${key}`} data-value={value}>
            <dt>{t(key)}</dt>
            <dd lang="zxx">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The run's fills with their side, and the orders that did not fill (AL-report-02), with a CSV of the fills. */
function ResultTrades({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const [saved, setSaved] = useState<boolean | null>(null);
  return (
    <div data-testid="quant-bar-trades">
      <Button
        type="button"
        data-testid="quant-bar-csv"
        disabled={!result.trades.length}
        onClick={() => setSaved(downloadCsv(tradesCsvName(result.runId), tradesCsv(result)))}
      >
        {t('downloadCsv')}
      </Button>
      {saved === false && <p className="error-text">{t('csvFailed')}</p>}
      {result.trades.length ? (
        <DataTable
          headers={[t('time'), t('side'), t('reason'), t('qty'), t('barPrice'), t('price'), t('fee'), t('slippageTotal')]}
          label={t('tradesTitle')}
        >
          {result.trades.map((trade, i) => (
            <tr key={`${trade.ts}:${i}`} data-testid="quant-bar-trade" data-ts={trade.ts} data-side={trade.side}>
              <td lang="zxx">{utcText(trade.ts)}</td>
              <td>{t(trade.side)}</td>
              <td>{t(trade.reason)}</td>
              <td lang="zxx">{trade.qty}</td>
              <td lang="zxx">{trade.barPrice}</td>
              <td lang="zxx">{trade.price}</td>
              <td lang="zxx">{trade.fee}</td>
              <td lang="zxx">{trade.slippage}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="muted">{t('tradesNone')}</p>
      )}
      {result.account && (
        <>
          <h4>{t('eventsTitle')}</h4>
          {result.marginEvents.length ? (
            <DataTable headers={[t('time'), t('eventKind'), t('price'), t('marginLevel')]} label={t('eventsTitle')}>
              {result.marginEvents.map((event, i) => (
                <tr
                  key={`${event.ts}:${i}`}
                  data-testid="quant-margin-event"
                  data-kind={event.kind}
                  data-ts={event.ts}
                  data-level={event.marginLevelPercent}
                  data-price={event.price}
                >
                  <td lang="zxx">{utcText(event.ts)}</td>
                  <td>{t(event.kind)}</td>
                  <td lang="zxx">{event.price}</td>
                  <td lang="zxx">{event.marginLevelPercent}</td>
                </tr>
              ))}
            </DataTable>
          ) : (
            <p className="muted" data-testid="quant-margin-events-none">
              {t('eventsNone')}
            </p>
          )}
        </>
      )}
      {result.rejected.length > 0 && (
        <DataTable headers={[t('time'), t('side'), t('reason')]} label={t('rejectedTitle')}>
          {result.rejected.map((row, i) => (
            <tr key={`${row.ts}:${i}`} data-testid="quant-bar-rejected" data-reason={row.reason}>
              <td lang="zxx">{utcText(row.ts)}</td>
              <td>{t(row.side)}</td>
              <td>{t(row.reason)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/** The equity curve with a marker on each fill (a triangle up for a buy, down for a sell); the table under it carries the same numbers. */
function ResultCharts({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const geometry = equityGeometry(result, CHART_W, CHART_H);
  return (
    <div data-testid="quant-bar-charts">
      {geometry ? (
        <figure className="quant-equity-chart">
          <svg
            viewBox={`-8 -8 ${CHART_W + 16} ${CHART_H + 16}`}
            role="img"
            aria-label={t('chartLabel')}
            data-testid="quant-bar-equity-chart"
          >
            <polyline
              points={geometry.line}
              fill="none"
              style={{ stroke: 'var(--if-lime)' }}
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {geometry.markers.map((marker, i) => {
              // Shape carries the side, not colour alone: a triangle up for a buy, down for a sell.
              const x = Number(marker.x);
              const y = Number(marker.y);
              const points =
                marker.side === 'buy'
                  ? `${x - 9},${y + 8} ${x + 9},${y + 8} ${x},${y - 8}`
                  : `${x - 9},${y - 8} ${x + 9},${y - 8} ${x},${y + 8}`;
              return (
                <polygon
                  key={`${marker.ts}:${i}`}
                  points={points}
                  style={{ fill: marker.side === 'buy' ? 'var(--if-up-text)' : 'var(--if-down-text)' }}
                  data-testid="quant-bar-marker"
                  data-side={marker.side}
                  data-ts={marker.ts}
                >
                  <title>{t('markerTitle', { side: t(marker.side), time: utcText(marker.ts) })}</title>
                </polygon>
              );
            })}
          </svg>
          <figcaption className="muted">{t('chartCaption')}</figcaption>
          {geometry.unmatched > 0 && <p className="error-text">{t('chartUnmatched', { count: geometry.unmatched })}</p>}
        </figure>
      ) : (
        <p className="muted">{t('chartTooFew')}</p>
      )}
      <details>
        <summary>{t('equityTitle')}</summary>
        <DataTable headers={[t('time'), t('equity'), ...(result.account ? [t('marginLevel')] : [])]} label={t('equityTitle')}>
          {result.equity.map((point) => (
            <tr key={point.ts} data-testid="quant-bar-equity" data-equity={point.equity} data-margin-level={point.marginLevelPercent ?? ''}>
              <td lang="zxx">{utcText(point.ts)}</td>
              <td lang="zxx">{point.equity}</td>
              {result.account && <td lang="zxx">{point.marginLevelPercent ?? '—'}</td>}
            </tr>
          ))}
        </DataTable>
      </details>
    </div>
  );
}

/** The run's log, derived from what it stored; the filter narrows it to warnings. */
function ResultLog({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  const lines = result.log.filter((line) => level === 'all' || line.level === 'warn');
  return (
    <div data-testid="quant-bar-log">
      <Select
        label={t('logFilter')}
        value={level}
        onChange={(value) => setLevel(value === 'warn' ? 'warn' : 'all')}
        options={[
          { value: 'all', label: t('logAll') },
          { value: 'warn', label: t('logWarn') },
        ]}
      />
      {lines.length ? (
        <ol className="quant-log">
          {lines.map((line, i) => (
            <li key={`${line.code}:${line.ts ?? ''}:${i}`} data-testid="quant-log-line" data-level={line.level} data-code={line.code}>
              <strong>{line.level === 'warn' ? t('levelWarn') : t('levelInfo')}</strong>{' '}
              {line.ts && <span lang="zxx">{utcText(line.ts)} </span>}
              <LogText line={line} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t('logNone')}</p>
      )}
    </div>
  );
}
