import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, signedDecimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
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
const backtestSchema = stamp.extend({
  ok: z.literal(true),
  runId: z.string(),
  strategyId: z.string(),
  walkForward: z.object({ inSampleFrom: z.string(), inSampleTo: z.string(), outOfSampleFrom: z.string(), outOfSampleTo: z.string() }),
  inSample: z.object({ fillCount: z.number().int(), notional: decimalSchema }),
  outOfSample: z.object({ fillCount: z.number().int(), notional: decimalSchema }),
  claimLabel: z.literal('Historical simulation — not a forecast'),
  outOfSampleLabel: z.string(),
});
export function Quant({ mode }: { mode: 'sandbox' | 'studio' | 'backtest' }) {
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
    [bt, setBt] = useState<z.infer<typeof backtestSchema> | null>(null),
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
        <a className="text-link" href="/quant">
          Sandbox
        </a>
        <a className="text-link" href="/quant/studio">
          Studio
        </a>
        <a className="text-link" href="/quant/backtest">
          Backtest
        </a>
        <a className="text-link" href="/execution">
          Execution
        </a>
      </div>
      <p className="more-badge">Simulated · no live trading authority</p>
      {mode === 'sandbox' ? (
        <div className="more-columns">
          <Panel title="Strategy sandbox">
            <Read resource={capabilities.resource} retry={capabilities.reload}>
              {(c) => (
                <p className="muted">
                  Isolate: {c.isolate}. Trade-only vault: {c.venueVault}.{c.refuse && ` ${c.refuse}.`}
                </p>
              )}
            </Read>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.stage({
                  title: 'Review simulated run',
                  confirm: 'Run simulation',
                  success: 'Simulation received',
                  content: (
                    <Details
                      items={[
                        ['Language', language],
                        ['Starting cash', `${cash} simulated units`],
                        ['Environment', 'Paper · never live performance'],
                      ]}
                    />
                  ),
                  run: async () => {
                    const res = await api.mutate(
                      'quant',
                      'sandbox.run',
                      { language, source, cash, environment: 'paper', presentedAs: 'paper' },
                      runSchema,
                    );
                    if (res.ok && action.isCurrent()) setResult(res.data);
                    return res;
                  },
                });
              }}
            >
              <Select label="Language" value={language} onChange={setLanguage} options={['javascript', 'typescript', 'python']} />
              <Field
                label="Simulated starting cash"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                inputMode="decimal"
                hint="User-supplied simulation input, separate from your ledger balance."
              />
              <TextArea label="Strategy source" value={source} onChange={setSource} maxLength={200000} />
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
                Review simulation
              </Button>
            </form>
            <p className="muted">Live deployment requires a separate, approved execution contract. This sandbox does not grant it.</p>
          </Panel>
          <Panel title="Simulation result">
            {result ? (
              <>
                <p>{result.claimLabel}</p>
                <Details
                  items={[
                    ['Cash', `${displayAmount(result.cash)} simulated units`],
                    ['P&L', `${displayAmount(result.pnl)} simulated units`],
                    ['Venue', result.venue],
                  ]}
                />
                <pre className="more-body">{result.logs.join('\n')}</pre>
                <DataTable headers={['Side', 'Symbol', 'Quantity', 'Price']} label="Simulated fills">
                  {result.fills.map((f, i) => (
                    <tr key={i}>
                      <td>{f.side}</td>
                      <td>{f.symbol}</td>
                      <td>{f.qty}</td>
                      <td>{f.price}</td>
                    </tr>
                  ))}
                </DataTable>
                {result.positions.length > 0 && (
                  <DataTable headers={['Position', 'Quantity']} label="Simulated positions">
                    {result.positions.map((p) => (
                      <tr key={p.symbol}>
                        <td>{p.symbol}</td>
                        <td>{p.qty}</td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </>
            ) : (
              <p className="muted">Run the connected isolate to receive its logs, fills, and positions.</p>
            )}
          </Panel>
        </div>
      ) : mode === 'studio' ? (
        <div className="more-columns">
          <Panel title="Build a strategy">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.stage({
                  title: 'Review strategy',
                  confirm: 'Save strategy',
                  success: 'Strategy saved in the deployment catalogue',
                  content: (
                    <Details
                      items={[
                        ['Name', name],
                        ['Blocks', blocks.map((b) => `${b.side} ${b.qty} ${b.symbol}`).join('\n')],
                        ['Simulation cash', cash],
                        ['Max drawdown', drawdown],
                        ['Max notional', notional],
                        ['Kill threshold', kill],
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
                      strategy,
                    ),
                  done: saved.reload,
                });
              }}
            >
              <Field label="Strategy name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
              <Field label="Simulated starting cash" value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" />
              {blocks.map((b, i) => (
                <fieldset key={i}>
                  <legend>Order block {i + 1}</legend>
                  <Select
                    label={`Block ${i + 1} side`}
                    value={b.side}
                    onChange={(v) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, side: v as 'buy' | 'sell' } : r)))}
                    options={['buy', 'sell']}
                  />
                  <Field
                    label={`Block ${i + 1} symbol`}
                    value={b.symbol}
                    onChange={(e) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, symbol: e.target.value } : r)))}
                    maxLength={32}
                  />
                  <Field
                    label={`Block ${i + 1} quantity`}
                    value={b.qty}
                    onChange={(e) => setBlocks((rows) => rows.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)))}
                    inputMode="decimal"
                  />
                  {blocks.length > 1 && (
                    <Button variant="ghost" onClick={() => setBlocks((rows) => rows.filter((_, j) => j !== i))}>
                      Remove block {i + 1}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button variant="secondary" onClick={() => setBlocks((rows) => [...rows, { side: 'buy', symbol: '', qty: '' }])}>
                Add block
              </Button>
              <Field label="Max drawdown (service unit unspecified)" value={drawdown} onChange={(e) => setDrawdown(e.target.value)} />
              <Field label="Max notional (service unit unspecified)" value={notional} onChange={(e) => setNotional(e.target.value)} />
              <Field label="Kill threshold (service unit unspecified)" value={kill} onChange={(e) => setKill(e.target.value)} />
              <Button type="submit" disabled={action.disabled || !name.trim() || !validCash || !validRisk || !validBlocks}>
                Review strategy
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
        <div className="more-columns">
          <div>
            <Panel title="Walk-forward backtest">
              <p className="muted">
                The service reads historical fills from its data lake. Ordered, disjoint windows and evidence for all costs are required.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action.stage({
                    title: 'Review historical simulation',
                    confirm: 'Run backtest',
                    success: 'Historical simulation received',
                    content: (
                      <Details
                        items={[
                          ['Strategy', strategyId],
                          ['Symbol', symbol],
                          ['In sample', `${isFrom} → ${isTo}`],
                          ['Out of sample', `${oosFrom} → ${oosTo}`],
                          ['Evidence verdict', verdict],
                          ['Variants tested', variants],
                        ]}
                      />
                    ),
                    run: async () => {
                      const res = await api.mutate(
                        'quant',
                        'backtest.run',
                        {
                          strategyId,
                          symbol,
                          walkForward: {
                            inSampleFrom: new Date(isFrom).toISOString(),
                            inSampleTo: new Date(isTo).toISOString(),
                            outOfSampleFrom: new Date(oosFrom).toISOString(),
                            outOfSampleTo: new Date(oosTo).toISOString(),
                          },
                          outOfSampleStatus: verdict,
                          costModel: {
                            fees: { kind: models.fees, source: evidence.fees },
                            slippage: { kind: models.slippage, source: evidence.slippage },
                            latency: { kind: models.latency, source: evidence.latency },
                          },
                          strategyVariantCount: Number(variants),
                          environment: 'backtest',
                          presentedAs: 'simulated',
                        },
                        backtestSchema,
                      );
                      if (res.ok && action.isCurrent()) setBt(res.data);
                      return res;
                    },
                  });
                }}
              >
                <Field label="Strategy ID" value={strategyId} onChange={(e) => setStrategyId(e.target.value)} />
                <Field label="Historical symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
                {[
                  ['In-sample start', isFrom, setIsFrom],
                  ['In-sample end', isTo, setIsTo],
                  ['Out-of-sample start', oosFrom, setOosFrom],
                  ['Out-of-sample end', oosTo, setOosTo],
                ].map(([label, value, set]) => (
                  <Field
                    key={label as string}
                    label={label as string}
                    type="datetime-local"
                    value={value as string}
                    onChange={(e) => (set as (s: string) => void)(e.target.value)}
                  />
                ))}
                <Select
                  label="Evidence-based out-of-sample verdict"
                  value={verdict}
                  onChange={setVerdict}
                  options={['passed', 'failed', 'inconclusive']}
                />
                <Field
                  label="Number of strategy variants tested"
                  value={variants}
                  onChange={(e) => setVariants(e.target.value)}
                  inputMode="numeric"
                />
                {(['fees', 'slippage', 'latency'] as const).map((key) => (
                  <fieldset key={key}>
                    <legend>{key} evidence</legend>
                    <Select
                      label={`${key} model`}
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
                      label={`${key} evidence source`}
                      value={evidence[key]}
                      onChange={(e) => setEvidence((v) => ({ ...v, [key]: e.target.value }))}
                    />
                  </fieldset>
                ))}
                <Button
                  type="submit"
                  disabled={
                    action.disabled ||
                    !strategyId ||
                    !symbol ||
                    ![isFrom, isTo, oosFrom, oosTo].every(Boolean) ||
                    !(
                      Date.parse(isFrom) < Date.parse(isTo) &&
                      Date.parse(isTo) <= Date.parse(oosFrom) &&
                      Date.parse(oosFrom) < Date.parse(oosTo)
                    ) ||
                    !/^[1-9]\d*$/.test(variants) ||
                    !Number.isSafeInteger(Number(variants)) ||
                    !Object.values(evidence).every((v) => v.trim())
                  }
                >
                  Review backtest
                </Button>
              </form>
            </Panel>
            <Saved resource={saved} limit={limit} setLimit={setLimit} onPick={(s) => setStrategyId(s.id)} />
          </div>
          <Panel title="Historical result">
            {bt ? (
              <>
                <p>{bt.claimLabel}</p>
                <p>{bt.outOfSampleLabel}</p>
                <Details
                  items={[
                    ['Run', bt.runId],
                    ['In-sample fills', bt.inSample.fillCount],
                    ['In-sample notional', `${bt.inSample.notional} historical quote units`],
                    ['Out-of-sample fills', bt.outOfSample.fillCount],
                    ['Out-of-sample notional', `${bt.outOfSample.notional} historical quote units`],
                  ]}
                />
              </>
            ) : (
              <p className="muted">
                A connected data lake and valid evidence are needed. This screen creates no forecast or return percentage.
              </p>
            )}
          </Panel>
        </div>
      )}
      {action.feedback}
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
    <Panel title="Deployment strategy catalogue">
      <p className="muted">
        This service stores a shared in-process catalogue. It publishes no private per-account storage or durable history.
      </p>
      <Read resource={resource.resource} retry={resource.reload} empty="No strategies are saved">
        {(data) => (
          <>
            <div className="more-grid">
              {data.strategies.map((s) => (
                <article key={s.id}>
                  <h3>{s.name}</h3>
                  <small>
                    {s.claimLabel} · {s.id}
                  </small>
                  <pre className="more-body">{s.source}</pre>
                  <Button variant="secondary" onClick={() => onPick(s)}>
                    Use {s.name}
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
