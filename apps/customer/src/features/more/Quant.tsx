import { t as copyText, Text } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, signedDecimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
import { preservePaperHref } from './trade-context';
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
                  {c.isolate}
                  <Text k="quant.trade.only.vault" />
                  {c.venueVault}.{c.refuse && ` ${c.refuse}.`}
                </p>
              )}
            </Read>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action.stage({
                  title: copyText('quant.review.simulated.run'),
                  confirm: copyText('quant.run.simulation'),
                  success: copyText('quant.simulation.received'),
                  content: (
                    <Details
                      items={[
                        [copyText('quant.language'), language],
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
                      runSchema,
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
                <p>{result.claimLabel}</p>
                <Details
                  items={[
                    [copyText('quant.cash'), copyText('quant.simulated.units', { amount: displayAmount(result.cash) })],
                    [copyText('quant.p.l'), copyText('quant.simulated.units', { amount: displayAmount(result.pnl) })],
                    [copyText('quant.venue'), result.venue],
                  ]}
                />
                <pre className="more-body">{result.logs.join('\n')}</pre>
                <DataTable
                  headers={[copyText('quant.side'), copyText('quant.symbol'), copyText('quant.quantity'), copyText('quant.price')]}
                  label={copyText('quant.simulated.fills')}
                >
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
                  <DataTable
                    headers={[copyText('quant.position'), copyText('quant.quantity')]}
                    label={copyText('quant.simulated.positions')}
                  >
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
                  title: copyText('quant.review.strategy'),
                  confirm: copyText('quant.save.strategy'),
                  success: copyText('quant.strategy.saved.in.the.deployment.catalogue'),
                  content: (
                    <Details
                      items={[
                        [copyText('quant.name'), name],
                        [copyText('quant.blocks'), blocks.map((b) => `${b.side} ${b.qty} ${b.symbol}`).join('\n')],
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
                      strategy,
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
        <div className="more-columns">
          <div>
            <Panel title={copyText('quant.walk.forward.backtest')}>
              <p className="muted">
                <Text k="quant.the.service.reads.historical.fills.from.its" />
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action.stage({
                    title: copyText('quant.review.historical.simulation'),
                    confirm: copyText('quant.run.backtest'),
                    success: copyText('quant.historical.simulation.received'),
                    content: (
                      <Details
                        items={[
                          [copyText('quant.strategy'), strategyId],
                          [copyText('quant.symbol'), symbol],
                          [copyText('quant.in.sample'), `${isFrom} → ${isTo}`],
                          [copyText('quant.out.of.sample'), `${oosFrom} → ${oosTo}`],
                          [copyText('quant.evidence.verdict'), verdict],
                          [copyText('quant.variants.tested'), variants],
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
                <Field label={copyText('quant.strategy.id')} value={strategyId} onChange={(e) => setStrategyId(e.target.value)} />
                <Field label={copyText('quant.historical.symbol')} value={symbol} onChange={(e) => setSymbol(e.target.value)} />
                {[
                  [copyText('quant.in.sample.start'), isFrom, setIsFrom],
                  [copyText('quant.in.sample.end'), isTo, setIsTo],
                  [copyText('quant.out.of.sample.start'), oosFrom, setOosFrom],
                  [copyText('quant.out.of.sample.end'), oosTo, setOosTo],
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
                />
                {(['fees', 'slippage', 'latency'] as const).map((key) => (
                  <fieldset key={key}>
                    <legend>
                      {key}
                      <Text k="quant.evidence" />
                    </legend>
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
                  <Text k="quant.review.backtest" />
                </Button>
              </form>
            </Panel>
            <Saved resource={saved} limit={limit} setLimit={setLimit} onPick={(s) => setStrategyId(s.id)} />
          </div>
          <Panel title={copyText('quant.historical.result')}>
            {bt ? (
              <>
                <p>{bt.claimLabel}</p>
                <p>{bt.outOfSampleLabel}</p>
                <Details
                  items={[
                    [copyText('quant.run'), bt.runId],
                    [copyText('quant.in.sample.fills'), bt.inSample.fillCount],
                    [copyText('quant.in.sample.notional'), copyText('quant.historical.quote.units', { amount: bt.inSample.notional })],
                    [copyText('quant.out.of.sample.fills'), bt.outOfSample.fillCount],
                    [
                      copyText('quant.out.of.sample.notional'),
                      copyText('quant.historical.quote.units', { amount: bt.outOfSample.notional }),
                    ],
                  ]}
                />
              </>
            ) : (
              <p className="muted">
                <Text k="quant.a.connected.data.lake.and.valid.evidence" />
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
                  <h3>{s.name}</h3>
                  <small>
                    {s.claimLabel} · {s.id}
                  </small>
                  <pre className="more-body">{s.source}</pre>
                  <Button variant="secondary" onClick={() => onPick(s)}>
                    <Text k="quant.use" />
                    {s.name}
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
