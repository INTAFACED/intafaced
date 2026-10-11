import { t as copyText, Text } from './copy';
import { useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, signedDecimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
import { preservePaperHref } from './trade-context';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import {
  historicalResultSchema,
  matchesHistoricalRequest,
  utcInput,
  type HistoricalRequest,
  type HistoricalSnapshot,
} from './quant-analysis';
import { QuantHistoricalRecord } from './QuantHistoricalRecord';
import { analysisCopy } from './quant-analysis-copy';
import './quant-analysis.css';
const stamp = z.object({
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});
const block = z.object({ side: z.enum(['buy', 'sell']), symbol: z.string(), qty: decimalSchema });
const strategy = stamp.extend({
  id: z.string(),
  name: z.string(),
  language: z.literal('javascript'),
  source: z.string(),
  cash: signedDecimalSchema,
  blocks: z.array(block),
  risk: z.object({ maxDrawdown: signedDecimalSchema, maxNotional: signedDecimalSchema, kill: signedDecimalSchema }),
});
const runSchema = stamp.extend({
  ok: z.literal(true),
  language: z.enum(['javascript', 'typescript', 'python']),
  logs: z.array(z.string()),
  cash: signedDecimalSchema,
  pnl: signedDecimalSchema,
  fills: z.array(
    z.object({ side: z.enum(['buy', 'sell']), symbol: z.string(), qty: decimalSchema, price: decimalSchema, venue: z.literal('internal') }),
  ),
  positions: z.array(z.object({ symbol: z.string(), qty: signedDecimalSchema })),
  venue: z.literal('internal'),
  venueVault: z.enum(['unset', 'set']),
});
export function Quant({ mode, paper = false }: { mode: 'sandbox' | 'studio' | 'backtest'; paper?: boolean }) {
  const api = useApi(),
    action = useAction(`quant-${mode}`);
  const [language, setLanguage] = useState('javascript'),
    [source, setSource] = useState(''),
    [cash, setCash] = useState(''),
    [name, setName] = useState(''),
    [blocks, setBlocks] = useState<{ side: 'buy' | 'sell'; symbol: string; qty: string }[]>([{ side: 'buy', symbol: '', qty: '' }]),
    [drawdown, setDrawdown] = useState(''),
    [notional, setNotional] = useState(''),
    [kill, setKill] = useState(''),
    [limit, setLimit] = useState(50),
    [result, setResult] = useState<z.infer<typeof runSchema> | null>(null),
    [bt, setBt] = useState<HistoricalSnapshot | null>(null),
    [strategyId, setStrategyId] = useState(''),
    [symbol, setSymbol] = useState(''),
    [isFrom, setIsFrom] = useState(''),
    [isTo, setIsTo] = useState(''),
    [oosFrom, setOosFrom] = useState(''),
    [oosTo, setOosTo] = useState(''),
    [verdict, setVerdict] = useState('inconclusive'),
    [variants, setVariants] = useState(''),
    [evidence, setEvidence] = useState({ fees: '', slippage: '', latency: '' }),
    [models, setModels] = useState({ fees: 'venue-schedule', slippage: 'order-book-replay', latency: 'measured-distribution' });
  const { Copy, t, languageFor, directionFor } = analysisCopy.useCopy();
  const draft = useRef<HTMLDivElement>(null);
  const [invalid, setInvalid] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<{ request: HistoricalRequest; view: object; result: ApiResult<unknown> } | null>(null);
  const windows = [isFrom, isTo, oosFrom, oosTo].map(utcInput);
  const validAnalysis = Boolean(
    strategyId.trim() &&
    symbol.trim() &&
    symbol.trim().length <= 32 &&
    windows.every(Boolean) &&
    windows[0]! < windows[1]! &&
    windows[1]! <= windows[2]! &&
    windows[2]! < windows[3]! &&
    /^[1-9]\d*$/.test(variants) &&
    Number.isSafeInteger(Number(variants)) &&
    Object.values(evidence).every((value) => value.trim()),
  );
  const latestFailure =
    lastAttempt?.view === action.viewIdentity &&
    lastAttempt.result === action.result &&
    !lastAttempt.result.ok &&
    lastAttempt.result.reason !== 'uncertain'
      ? lastAttempt
      : null;
  const capabilities = useResource(
    (signal) =>
      api.query(
        'quant',
        'sandbox.capabilities',
        undefined,
        z.object({
          isolate: z.enum(['wired', 'unwired']),
          languages: z.array(z.enum(['javascript', 'typescript', 'python'])),
          venueVault: z.enum(['trade-only', 'unset']),
          refuse: z.string().nullable(),
        }),
        { signal },
      ),
    'quant-capabilities',
  );
  const saved = useResource(
    (signal) =>
      mode === 'studio' || mode === 'backtest'
        ? api.query('quant', 'studio.list', { limit }, z.object({ strategies: z.array(strategy) }), { signal })
        : Promise.resolve({ ok: true as const, data: { strategies: [] } }),
    `quant-saved:${mode}:${limit}`,
  );
  const validCash = signedDecimalSchema.safeParse(cash).success;
  const validRisk = [drawdown, notional, kill].every((v) => signedDecimalSchema.safeParse(v).success);
  const validBlocks = blocks.every((b) => Boolean(b.symbol.trim()) && decimalSchema.safeParse(b.qty).success && parseAmount(b.qty) > 0n);
  return (
    <div className="more-grid">
      <div className="more-toolbar">
        <a className="text-link" href={preservePaperHref('/quant', paper)}>
          <Text k="quant.sandbox" />
        </a>
        <a className="text-link" href={preservePaperHref('/quant/studio', paper)}>
          <Text k="quant.studio" />
        </a>
        <a className="text-link" href={preservePaperHref('/quant/backtest', paper)}>
          <Text k="quant.backtest" />
        </a>
        <a className="text-link" href={preservePaperHref('/execution', paper)}>
          <Text k="quant.execution" />
        </a>
      </div>
      <p className="more-badge">
        <Text k="quant.simulated.no.live.trading.authority" />
      </p>
      {mode === 'sandbox' ? (
        <div className="more-columns">
          <Panel title={copyText('quant.strategy.sandbox')}>
            <Read resource={capabilities.resource} retry={capabilities.reload}>
              {(c) => (
                <p className="muted">
                  <Text k="quant.isolate" />
                  <span lang="zxx">{c.isolate}</span>
                  <Text k="quant.trade.only.vault" />
                  <span lang="zxx">{c.venueVault}</span>.{c.refuse && <span lang="zxx"> {c.refuse}.</span>}
                </p>
              )}
            </Read>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.stage({
                  title: () => copyText('quant.review.simulated.run'),
                  confirm: () => copyText('quant.run.simulation'),
                  success: () => copyText('quant.simulation.received'),
                  content: () => (
                    <Details
                      items={[
                        [copyText('quant.language'), <span lang="zxx">{language}</span>],
                        [copyText('quant.starting.cash'), copyText('quant.simulated.units', { amount: cash })],
                        [copyText('quant.environment'), copyText('quant.paper.never.live.performance')],
                      ]}
                    />
                  ),
                  run: async () => {
                    const res = await api.mutate(
                      'quant',
                      'sandbox.run',
                      { language, source, cash, environment: 'paper', presentedAs: 'paper' },
                      runSchema.refine(
                        (data) =>
                          data.language === language &&
                          data.environment === 'paper' &&
                          data.kind === 'paper' &&
                          data.claimLabel === 'Paper — not live performance',
                        'The simulation result does not match the reviewed language and environment',
                      ),
                    );
                    if (res.ok && action.isCurrent()) setResult(res.data);
                    return res;
                  },
                });
              }}
            >
              <Select
                label={copyText('quant.language')}
                value={language}
                onChange={setLanguage}
                options={['javascript', 'typescript', 'python']}
              />
              <Field
                label={copyText('quant.simulated.starting.cash')}
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                inputMode="decimal"
                hint={copyText('quant.user.supplied.simulation.input.separate.from.your')}
              />
              <TextArea label={copyText('quant.strategy.source')} value={source} onChange={setSource} maxLength={200000} />
              <Button
                type="submit"
                disabled={
                  action.disabled ||
                  !source.trim() ||
                  !validCash ||
                  capabilities.resource.status !== 'ready' ||
                  capabilities.resource.data.isolate !== 'wired'
                }
              >
                <Text k="quant.review.simulation" />
              </Button>
            </form>
            <p className="muted">
              <Text k="quant.live.deployment.requires.a.separate.approved.execution" />
            </p>
          </Panel>
          <Panel title={copyText('quant.simulation.result')}>
            {result ? (
              <>
                <p lang="und">{result.claimLabel}</p>
                <Details
                  items={[
                    [copyText('quant.cash'), copyText('quant.simulated.units', { amount: displayAmount(result.cash) })],
                    [copyText('quant.p.l'), copyText('quant.simulated.units', { amount: displayAmount(result.pnl) })],
                    [copyText('quant.venue'), <span lang="zxx">{result.venue}</span>],
                  ]}
                />
                <pre className="more-body" lang="und">
                  {result.logs.join('\n')}
                </pre>
                <DataTable
                  headers={[copyText('quant.side'), copyText('quant.symbol'), copyText('quant.quantity'), copyText('quant.price')]}
                  label={copyText('quant.simulated.fills')}
                >
                  {result.fills.map((f, i) => (
                    <tr key={i}>
                      <td lang="zxx">{f.side}</td>
                      <td lang="zxx">{f.symbol}</td>
                      <td lang="zxx">{f.qty}</td>
                      <td lang="zxx">{f.price}</td>
                    </tr>
                  ))}
                </DataTable>
                {result.positions.length > 0 && (
                  <DataTable
                    headers={[copyText('quant.position'), copyText('quant.quantity')]}
                    label={copyText('quant.simulated.positions')}
                  >
                    {result.positions.map((p) => (
                      <tr key={p.symbol}>
                        <td lang="zxx">{p.symbol}</td>
                        <td lang="zxx">{p.qty}</td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </>
            ) : (
              <p className="muted">
                <Text k="quant.run.the.connected.isolate.to.receive.its" />
              </p>
            )}
          </Panel>
        </div>
      ) : mode === 'studio' ? (
        <div className="more-columns">
          <Panel title={copyText('quant.build.a.strategy')}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.stage({
                  title: () => copyText('quant.review.strategy'),
                  confirm: () => copyText('quant.save.strategy'),
                  success: () => copyText('quant.strategy.saved.in.the.deployment.catalogue'),
                  content: () => (
                    <Details
                      items={[
                        [copyText('quant.name'), <span lang="und">{name}</span>],
                        [
                          copyText('quant.blocks'),
                          <span lang="zxx">{blocks.map((b) => `${b.side} ${b.qty} ${b.symbol}`).join('\n')}</span>,
                        ],
                        [copyText('quant.simulation.cash'), cash],
                        [copyText('quant.max.drawdown'), drawdown],
                        [copyText('quant.max.notional'), notional],
                        [copyText('quant.kill.threshold'), kill],
                      ]}
                    />
                  ),
                  run: () =>
                    api.mutate(
                      'quant',
                      'studio.save',
                      {
                        name: name.trim(),
                        blocks,
                        risk: { maxDrawdown: drawdown, maxNotional: notional, kill },
                        cash,
                        environment: 'paper',
                        presentedAs: 'paper',
                      },
                      strategy.refine(
                        (data) =>
                          data.environment === 'paper' &&
                          data.kind === 'paper' &&
                          data.claimLabel === 'Paper — not live performance' &&
                          data.name === name.trim() &&
                          parseAmount(data.cash) === parseAmount(cash) &&
                          data.blocks.length === blocks.length &&
                          data.blocks.every(
                            (block, index) =>
                              block.side === blocks[index]!.side &&
                              block.symbol === blocks[index]!.symbol.trim() &&
                              parseAmount(block.qty) === parseAmount(blocks[index]!.qty),
                          ) &&
                          parseAmount(data.risk.maxDrawdown) === parseAmount(drawdown) &&
                          parseAmount(data.risk.maxNotional) === parseAmount(notional) &&
                          parseAmount(data.risk.kill) === parseAmount(kill),
                        'The saved strategy does not match the reviewed simulation inputs',
                      ),
                    ),
                  done: saved.reload,
                });
              }}
            >
              <Field label={copyText('quant.strategy.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
              <Field
                label={copyText('quant.simulated.starting.cash')}
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                inputMode="decimal"
              />
              {blocks.map((b, i) => (
                <fieldset key={i}>
                  <legend>
                    <Text k="quant.order.block" />
                    {i + 1}
                  </legend>
                  <Select
                    label={copyText('quant.block.side', { value1: i + 1 })}
                    value={b.side}
                    onChange={(v) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, side: v as 'buy' | 'sell' } : r)))}
                    options={['buy', 'sell']}
                  />
                  <Field
                    label={copyText('quant.block.symbol', { value1: i + 1 })}
                    value={b.symbol}
                    onChange={(e) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, symbol: e.target.value } : r)))}
                    maxLength={32}
                  />
                  <Field
                    label={copyText('quant.block.quantity', { value1: i + 1 })}
                    value={b.qty}
                    onChange={(e) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)))}
                    inputMode="decimal"
                  />
                  {blocks.length > 1 && (
                    <Button variant="ghost" onClick={() => setBlocks((rows) => rows.filter((_, j) => j !== i))}>
                      <Text k="quant.remove.block" />
                      {i + 1}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button variant="secondary" onClick={() => setBlocks((rows) => [...rows, { side: 'buy', symbol: '', qty: '' }])}>
                <Text k="quant.add.block" />
              </Button>
              <Field
                label={copyText('quant.max.drawdown.service.unit.unspecified')}
                value={drawdown}
                onChange={(e) => setDrawdown(e.target.value)}
              />
              <Field
                label={copyText('quant.max.notional.service.unit.unspecified')}
                value={notional}
                onChange={(e) => setNotional(e.target.value)}
              />
              <Field
                label={copyText('quant.kill.threshold.service.unit.unspecified')}
                value={kill}
                onChange={(e) => setKill(e.target.value)}
              />
              <Button type="submit" disabled={action.disabled || !name.trim() || !validCash || !validRisk || !validBlocks}>
                <Text k="quant.review.strategy" />
              </Button>
            </form>
          </Panel>
          <Saved
            resource={saved}
            limit={limit}
            setLimit={setLimit}
            onPick={(s) => {
              setName(s.name);
              setCash(s.cash);
              setBlocks(s.blocks);
              setDrawdown(s.risk.maxDrawdown);
              setNotional(s.risk.maxNotional);
              setKill(s.risk.kill);
            }}
          />
        </div>
      ) : (
        <div lang={languageFor('draft')} dir={directionFor('draft')}>
          {latestFailure && (
            <div className="quant-latest-failure">
              <h3>
                <Copy k="latestFailed" />
              </h3>
              <p lang="zxx">
                {latestFailure.request.strategyId} · {latestFailure.request.symbol}
              </p>
              {bt?.view === action.viewIdentity && (
                <p>
                  <Copy k="previous" />
                </p>
              )}
            </div>
          )}
          {action.feedback}
          {action.unresolvedId && (
            <div className="quant-original-context">
              <p>
                <Copy k="originalAttempt" />
              </p>
              <code lang="zxx">{action.unresolvedId}</code>
              <p className="muted">
                <Copy k="unknownBody" />
              </p>
              <div className="actions">
                <a className="button button--secondary" href="/support">
                  <Copy k="contact" />
                </a>
                <a className="button button--secondary" href={preservePaperHref('/quant/studio', paper)}>
                  <Text k="quant.studio" />
                </a>
              </div>
            </div>
          )}
          <div className="quant-workbench">
            <div>
              <QuantHistoricalRecord snapshot={bt} view={action.viewIdentity} />
              <Button
                variant="secondary"
                onClick={() => {
                  draft.current?.scrollIntoView({ block: 'start' });
                  draft.current?.querySelector('input')?.focus({ preventScroll: true });
                }}
              >
                <Copy k="configure" />
              </Button>
            </div>
            <div className="quant-analysis-draft" ref={draft}>
              <Panel title={t('draft')}>
                <p className="muted">
                  <Copy k="draftBody" />
                </p>
                <p className="muted">
                  <Copy k="fullStrategy" />
                </p>
                <details className="quant-catalogue">
                  <summary>
                    <Copy k="catalogue" />
                  </summary>
                  <Saved resource={saved} limit={limit} setLimit={setLimit} onPick={(s) => setStrategyId(s.id)} />
                </details>
                <p className="muted">
                  <Copy k="utc" />
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!validAnalysis || action.disabled) {
                      setInvalid(true);
                      return;
                    }
                    setInvalid(false);
                    const request: HistoricalRequest = {
                      strategyId: strategyId.trim(),
                      symbol: symbol.trim(),
                      walkForward: {
                        inSampleFrom: windows[0]!,
                        inSampleTo: windows[1]!,
                        outOfSampleFrom: windows[2]!,
                        outOfSampleTo: windows[3]!,
                      },
                      outOfSampleStatus: verdict as HistoricalRequest['outOfSampleStatus'],
                      strategyVariantCount: Number(variants),
                      costModel: {
                        fees: { kind: models.fees, source: evidence.fees.trim() },
                        slippage: { kind: models.slippage, source: evidence.slippage.trim() },
                        latency: { kind: models.latency, source: evidence.latency.trim() },
                      },
                      environment: 'backtest',
                      presentedAs: 'simulated',
                    };
                    const view = action.viewIdentity;
                    action.stage({
                      title: () => copyText('quant.review.historical.simulation'),
                      confirm: () => copyText('quant.run.backtest'),
                      success: () => copyText('quant.historical.simulation.received'),
                      content: () => (
                        <>
                          <p>
                            <Copy k="utc" />
                          </p>
                          <Details
                            items={[
                              [copyText('quant.strategy'), <span lang="zxx">{request.strategyId}</span>],
                              [copyText('quant.symbol'), <span lang="zxx">{request.symbol}</span>],
                              [
                                copyText('quant.in.sample'),
                                <span lang="zxx">{request.walkForward.inSampleFrom + ' → ' + request.walkForward.inSampleTo}</span>,
                              ],
                              [
                                copyText('quant.out.of.sample'),
                                <span lang="zxx">{request.walkForward.outOfSampleFrom + ' → ' + request.walkForward.outOfSampleTo}</span>,
                              ],
                              [copyText('quant.evidence.verdict'), <span lang="zxx">{request.outOfSampleStatus}</span>],
                              [analysisCopy.t('variants'), String(request.strategyVariantCount)],
                              ...(['fees', 'slippage', 'latency'] as const).map(
                                (key) =>
                                  [
                                    analysisCopy.t(key),
                                    <span lang="und">
                                      {request.costModel[key].kind} · {request.costModel[key].source}
                                    </span>,
                                  ] as [string, ReactNode],
                              ),
                            ]}
                          />
                          <p className="muted">
                            <Copy k="fullStrategy" />
                          </p>
                        </>
                      ),
                      run: async (canDispatch) => {
                        if (!canDispatch()) return authoredRefusal('aborted', { key: 'beforeDispatch' });
                        const response = await api.mutate(
                          'quant',
                          'backtest.run',
                          request,
                          historicalResultSchema.refine(
                            (data) => matchesHistoricalRequest(data, request),
                            'The historical result does not match the reviewed strategy, windows and declared verdict',
                          ),
                        );
                        if (action.isCurrent()) {
                          setLastAttempt({ request, view, result: response });
                          if (response.ok) setBt({ data: response.data, request, view });
                        }
                        return response;
                      },
                    });
                  }}
                >
                  <Field
                    label={copyText('quant.strategy.id')}
                    value={strategyId}
                    onChange={(e) => setStrategyId(e.target.value)}
                    required
                  />
                  <Field
                    label={copyText('quant.historical.symbol')}
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    maxLength={32}
                    required
                  />
                  <div className="quant-date-fields">
                    {[
                      ['inSampleFrom', copyText('quant.in.sample.start'), isFrom, setIsFrom],
                      ['inSampleTo', copyText('quant.in.sample.end'), isTo, setIsTo],
                      ['outOfSampleFrom', copyText('quant.out.of.sample.start'), oosFrom, setOosFrom],
                      ['outOfSampleTo', copyText('quant.out.of.sample.end'), oosTo, setOosTo],
                    ].map(([field, label, value, set]) => (
                      <Field
                        key={field as string}
                        label={label as string}
                        type="datetime-local"
                        value={value as string}
                        onChange={(e) => (set as (value: string) => void)(e.target.value)}
                        required
                      />
                    ))}
                  </div>
                  <Select
                    label={copyText('quant.evidence.based.out.of.sample.verdict')}
                    value={verdict}
                    onChange={setVerdict}
                    options={['passed', 'failed', 'inconclusive']}
                  />
                  <Field
                    label={copyText('quant.number.of.strategy.variants.tested')}
                    value={variants}
                    onChange={(e) => setVariants(e.target.value)}
                    inputMode="numeric"
                    required
                  />
                  {(['fees', 'slippage', 'latency'] as const).map((key) => (
                    <fieldset key={key} className="quant-cost-fields">
                      <legend>{t(key)}</legend>
                      <Select
                        label={copyText('quant.model', { value1: key })}
                        value={models[key]}
                        onChange={(value) => setModels((v) => ({ ...v, [key]: value }))}
                        options={
                          key === 'fees'
                            ? ['venue-schedule', 'tiered-venue-schedule']
                            : key === 'slippage'
                              ? ['order-book-replay', 'measured-impact']
                              : ['measured-distribution', 'event-replay']
                        }
                      />
                      <Field
                        label={copyText('quant.evidence.source', { value1: key })}
                        value={evidence[key]}
                        onChange={(e) => setEvidence((v) => ({ ...v, [key]: e.target.value }))}
                        required
                      />
                    </fieldset>
                  ))}
                  {invalid && (
                    <p role="alert">
                      <Copy k="invalid" />
                    </p>
                  )}
                  <Button type="submit" disabled={action.disabled || !validAnalysis}>
                    <Copy k="review" />
                  </Button>
                </form>
              </Panel>
            </div>
          </div>
        </div>
      )}
      {mode !== 'backtest' && action.feedback}
      {action.dialog}
    </div>
  );
}
function Saved({
  resource,
  limit,
  setLimit,
  onPick,
}: {
  resource: ReturnType<typeof useResource<{ strategies: z.infer<typeof strategy>[] }>>;
  limit: number;
  setLimit: (n: number) => void;
  onPick: (s: z.infer<typeof strategy>) => void;
}) {
  return (
    <Panel title={copyText('quant.deployment.strategy.catalogue')}>
      <p className="muted">
        <Text k="quant.this.service.stores.a.shared.in.process" />
      </p>
      <Read resource={resource.resource} retry={resource.reload} empty={copyText('quant.no.strategies.are.saved')}>
        {(data) => (
          <>
            <div className="more-grid">
              {data.strategies.map((s) => (
                <article key={s.id}>
                  <h3 lang="und">{s.name}</h3>
                  <small>
                    <span lang="und">{s.claimLabel}</span> · <span lang="zxx">{s.id}</span>
                  </small>
                  <pre className="more-body" lang="und">
                    {s.source}
                  </pre>
                  <Button variant="secondary" onClick={() => onPick(s)}>
                    <Text k="quant.use" />
                    <span lang="und">{s.name}</span>
                  </Button>
                </article>
              ))}
            </div>
            <Limit count={data.strategies.length} limit={limit} cap={50} onChange={setLimit} />
          </>
        )}
      </Read>
    </Panel>
  );
}
