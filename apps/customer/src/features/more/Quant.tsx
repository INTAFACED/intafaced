import { t as copyText, Text } from './copy';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, signedDecimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Read, Select, TextArea, useAction } from './common';
import { preservePaperHref } from './trade-context';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import { refusalCopy } from '../../data/refusals';
import {
  COST_MODELS,
  type CostKey,
  HYPOTHESES,
  HYPOTHESIS_COPY,
  MODEL_COPY,
  draftStrategyNames,
  historicalResultSchema,
  matchesHistoricalRequest,
  utcInput,
  type HistoricalRequest,
  type HistoricalSnapshot,
} from './quant-analysis';
import { QuantHistoricalRecord } from './QuantHistoricalRecord';
import { StudioLibrary } from '../quant/StudioLibrary';
import { StudioSave } from '../quant/StudioSave';
import { fingerprint, newLink, readLink, writeLink, type StudioLink } from '../quant/studio-save';
import { studioCopy } from '../quant/studio-copy';
import { builderCopy } from '../quant/builder-copy';
import { SignalBuilder } from '../quant/SignalBuilder';
import { StudioTemplates } from '../quant/StudioTemplates';
import { emptySignalRules } from '../quant/signal-rules';
import type { QuantSignalRules } from '@intafaced/contracts/quant-algo';
import { emptyDraft, readDraft, writeDraft } from './quant-draft';
import { analysisCopy } from './quant-analysis-copy';
import { QuantRooms } from '../quant/QuantRooms';
import './quant-analysis.css';
/** A service sometimes answers with its own refusal code; customers read the plain sentence for it instead. */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
const stamp = z.object({
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
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
/** The plain-English name of a cost model; an unknown model from the service is shown as received. */
function modelLabel(t: (key: (typeof MODEL_COPY)[keyof typeof MODEL_COPY]) => string, kind: string) {
  return kind in MODEL_COPY ? t(MODEL_COPY[kind as keyof typeof MODEL_COPY]) : kind;
}
export function Quant({ mode, paper = false }: { mode: 'sandbox' | 'studio' | 'backtest'; paper?: boolean }) {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction(`quant-${mode}`);
  const [draftStart] = useState(() => (mode === 'studio' ? (readDraft(userId ?? null) ?? emptyDraft()) : emptyDraft()));
  const [language, setLanguage] = useState('javascript'),
    [source, setSource] = useState(''),
    [cash, setCash] = useState(draftStart.cash),
    [name, setName] = useState(draftStart.name),
    [blocks, setBlocks] = useState<{ side: 'buy' | 'sell'; symbol: string; qty: string }[]>(draftStart.blocks),
    [modules, setModules] = useState<QuantSignalRules | null>(draftStart.modules),
    [drawdown, setDrawdown] = useState(draftStart.drawdown),
    [notional, setNotional] = useState(draftStart.notional),
    [kill, setKill] = useState(draftStart.kill),
    [link, setLink] = useState<StudioLink>(() => (mode === 'studio' ? readLink(userId ?? null) : newLink())),
    [libraryRevision, setLibraryRevision] = useState(0),
    [replacing, setReplacing] = useState<string | null>(null),
    [result, setResult] = useState<z.infer<typeof runSchema> | null>(null),
    [bt, setBt] = useState<HistoricalSnapshot | null>(null),
    [strategyId, setStrategyId] = useState(''),
    [symbol, setSymbol] = useState(''),
    [isFrom, setIsFrom] = useState(''),
    [isTo, setIsTo] = useState(''),
    [oosFrom, setOosFrom] = useState(''),
    [oosTo, setOosTo] = useState(''),
    [verdict, setVerdict] = useState<(typeof HYPOTHESES)[number]>('inconclusive'),
    [variants, setVariants] = useState(''),
    [evidence, setEvidence] = useState({ fees: '', slippage: '', latency: '' }),
    [models, setModels] = useState<Record<CostKey, string>>({
      fees: 'venue-schedule',
      slippage: 'order-book-replay',
      latency: 'measured-distribution',
    });
  const { Copy, t, languageFor, directionFor } = analysisCopy.useCopy();
  const draft = useRef<HTMLDivElement>(null);
  // Backtest still picks from the named draft kept on this device; it does not read the account library.
  const [studioDraft] = useState(() => (mode === 'backtest' ? readDraft(userId ?? null) : null));
  const strategyNames = draftStrategyNames(studioDraft);
  const [lastAttempt, setLastAttempt] = useState<{ request: HistoricalRequest; view: object; result: ApiResult<unknown> } | null>(null);
  const windows = [isFrom, isTo, oosFrom, oosTo].map(utcInput);
  const validAnalysis = Boolean(
    strategyNames.includes(strategyId) &&
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
  const validCash = signedDecimalSchema.safeParse(cash).success;
  useEffect(() => {
    if (mode === 'studio') writeDraft(userId ?? null, { name, cash, blocks, modules, drawdown, notional, kill });
  }, [mode, userId, name, cash, blocks, modules, drawdown, notional, kill]);
  useEffect(() => {
    if (mode === 'studio') writeLink(userId ?? null, link);
  }, [mode, userId, link]);
  const rules = { name, cash, blocks, modules, risk: { maxDrawdown: drawdown, maxNotional: notional, kill } };
  const blankRules = fingerprint({
    name: '',
    cash: '',
    blocks: emptyDraft().blocks,
    modules: null,
    risk: { maxDrawdown: '', maxNotional: '', kill: '' },
  });
  /** Unsaved rules are never replaced on one press: the first press warns, a second press of the same control goes on. */
  const confirmReplace = (control: string): boolean => {
    const current = fingerprint(rules);
    if (current === blankRules || current === link.saved || replacing === control) {
      setReplacing(null);
      return true;
    }
    setReplacing(control);
    return false;
  };
  /** Fill the form with saved rules (or a blank draft) and remember which strategy it is. */
  const load = (
    next: { name: string; cash: string; blocks: typeof blocks; modules: QuantSignalRules | null; risk: typeof rules.risk } | null,
    nextLink: StudioLink,
  ) => {
    const draft = next ?? { ...emptyDraft(), risk: { maxDrawdown: '', maxNotional: '', kill: '' } };
    setName(draft.name);
    setCash(draft.cash);
    // A strategy of signal rules has no blocks; the form still keeps one blank block row for switching back.
    setBlocks(draft.blocks.length ? draft.blocks.map((b) => ({ ...b })) : emptyDraft().blocks);
    setModules(draft.modules ? structuredClone(draft.modules) : null);
    setDrawdown(draft.risk.maxDrawdown);
    setNotional(draft.risk.maxNotional);
    setKill(draft.risk.kill);
    setLink(nextLink);
  };
  return (
    <div className="more-grid">
      <QuantRooms active={mode} paper={paper} />
      <p className="more-badge">
        <Text k="quant.simulated.no.live.trading.authority" />
      </p>
      {mode === 'sandbox' ? (
        <div className="more-columns">
          <Panel title={copyText('quant.strategy.sandbox')}>
            <Read resource={capabilities.resource} retry={capabilities.reload}>
              {(c) => (
                <p className="muted">
                  <Text k={c.isolate === 'wired' ? 'quant.isolate' : 'quant.runner.off'} />{' '}
                  <Text k={c.venueVault === 'trade-only' ? 'quant.trade.only.vault' : 'quant.exchange.off'} />
                  {c.refuse && <span lang="zxx"> {RAW_CODE.test(c.refuse) ? refusalCopy(c.refuse).body : c.refuse}</span>}
                </p>
              )}
            </Read>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const idempotencyKey = crypto.randomUUID();
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
                      { language, source, cash, environment: 'paper', presentedAs: 'paper', idempotencyKey },
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
                <pre data-testid="more-body" className="more-body" lang="und">
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
            <form onSubmit={(e) => e.preventDefault()}>
              <Field label={copyText('quant.strategy.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
              <Field
                label={copyText('quant.simulated.starting.cash')}
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                inputMode="decimal"
              />
              <Select
                label={builderCopy.t('rulesKind')}
                value={modules ? 'signal' : 'blocks'}
                onChange={(v) => setModules(v === 'signal' ? (modules ?? emptySignalRules()) : null)}
                options={[
                  { value: 'blocks', label: builderCopy.t('kindBlocks') },
                  { value: 'signal', label: builderCopy.t('kindSignal') },
                ]}
              />
              {modules && <SignalBuilder value={modules} onChange={setModules} />}
              {!modules &&
                blocks.map((b, i) => (
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
              {!modules && (
                <Button variant="secondary" onClick={() => setBlocks((rows) => [...rows, { side: 'buy', symbol: '', qty: '' }])}>
                  <Text k="quant.add.block" />
                </Button>
              )}
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
              <StudioSave
                rules={rules}
                link={link}
                onSaved={(head, saved) => {
                  setLink({ clientStrategyId: head.clientStrategyId, strategyId: head.id, version: head.version, saved });
                  setLibraryRevision((n) => n + 1);
                }}
              />
              <Button variant="ghost" onClick={() => confirmReplace('new') && load(null, newLink())}>
                {studioCopy.t('newStrategy')}
              </Button>
              {replacing && (
                <p role="alert" data-testid="quant-replace-warning">
                  {studioCopy.t('replaceWarning')}
                </p>
              )}
            </form>
          </Panel>
          <StudioLibrary
            revision={libraryRevision}
            activeId={link.strategyId}
            onOpen={(head) =>
              confirmReplace(`open:${head.id}`) &&
              load(head, {
                clientStrategyId: head.clientStrategyId,
                strategyId: head.id,
                version: head.version,
                saved: fingerprint(head),
              })
            }
          />
          <StudioTemplates
            onUse={(template) => {
              if (!confirmReplace(`template:${template.id}`)) return false;
              // A new draft: the template's choices with every number blank, and no cash or risk filled in for you.
              load(
                {
                  name: template.name,
                  cash: '',
                  blocks: [],
                  modules: template.rules,
                  risk: { maxDrawdown: '', maxNotional: '', kill: '' },
                },
                newLink(),
              );
              return true;
            }}
          />
        </div>
      ) : (
        <div lang={languageFor('draft')} dir={directionFor('draft')}>
          {latestFailure && (
            <div data-testid="quant-latest-failure" className="quant-latest-failure">
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
            <div data-testid="quant-original-context" className="quant-original-context">
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
          <div data-testid="quant-workbench" className="quant-workbench">
            <div>
              <QuantHistoricalRecord snapshot={bt} view={action.viewIdentity} />
              <Button
                variant="secondary"
                onClick={() => {
                  draft.current?.scrollIntoView({ block: 'start' });
                  draft.current?.querySelector<HTMLElement>('select, input')?.focus({ preventScroll: true });
                }}
              >
                <Copy k="configure" />
              </Button>
            </div>
            <div data-testid="quant-analysis-draft" className="quant-analysis-draft" ref={draft}>
              <Panel title={t('draft')}>
                <p className="muted">
                  <Copy k="draftBody" />
                </p>
                <p className="muted">
                  <Copy k="fullStrategy" />
                </p>
                <p className="muted">
                  <Copy k="utc" />
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!validAnalysis || action.disabled) return;
                    const idempotencyKey = crypto.randomUUID();
                    const request: HistoricalRequest = {
                      strategyId: strategyId.trim(),
                      symbol: symbol.trim(),
                      walkForward: {
                        inSampleFrom: windows[0]!,
                        inSampleTo: windows[1]!,
                        outOfSampleFrom: windows[2]!,
                        outOfSampleTo: windows[3]!,
                      },
                      outOfSampleStatus: verdict,
                      strategyVariantCount: Number(variants),
                      costModel: {
                        fees: { kind: models.fees, source: evidence.fees.trim() },
                        slippage: { kind: models.slippage, source: evidence.slippage.trim() },
                        latency: { kind: models.latency, source: evidence.latency.trim() },
                      },
                      environment: 'backtest',
                      presentedAs: 'simulated',
                      idempotencyKey,
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
                              [copyText('quant.strategy'), request.strategyId],
                              [copyText('quant.symbol'), <span lang="zxx">{request.symbol}</span>],
                              [
                                copyText('quant.in.sample'),
                                <span lang="zxx">{request.walkForward.inSampleFrom + ' → ' + request.walkForward.inSampleTo}</span>,
                              ],
                              [
                                copyText('quant.out.of.sample'),
                                <span lang="zxx">{request.walkForward.outOfSampleFrom + ' → ' + request.walkForward.outOfSampleTo}</span>,
                              ],
                              [t('verdict'), t(HYPOTHESIS_COPY[request.outOfSampleStatus])],
                              [analysisCopy.t('variants'), String(request.strategyVariantCount)],
                              ...(['fees', 'slippage', 'latency'] as const).map(
                                (key) =>
                                  [
                                    analysisCopy.t(key),
                                    <span lang="und">
                                      {modelLabel(t, request.costModel[key].kind)} · {request.costModel[key].source}
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
                  {strategyNames.length ? (
                    <>
                      <Select
                        label={t('strategyLabel')}
                        value={strategyId}
                        onChange={setStrategyId}
                        options={[
                          { value: '', label: t('strategyChoose') },
                          ...strategyNames.map((name) => ({ value: name, label: name })),
                        ]}
                      />
                      <p className="muted">
                        <Copy k="strategyNote" />
                      </p>
                    </>
                  ) : (
                    <div className="field" role="group" aria-label={t('strategyLabel')}>
                      <span>{t('strategyLabel')}</span>
                      <p className="muted">
                        <Copy k={studioDraft ? 'strategyUnnamed' : 'strategyNone'} />{' '}
                        <a className="text-link" href={preservePaperHref('/quant/studio', paper)}>
                          <Copy k="strategyOpenStudio" />
                        </a>
                      </p>
                    </div>
                  )}
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
                    label={t('hypothesis')}
                    value={verdict}
                    onChange={(value) => setVerdict(value as (typeof HYPOTHESES)[number])}
                    options={HYPOTHESES.map((value) => ({ value, label: t(HYPOTHESIS_COPY[value]) }))}
                  />
                  <p className="muted">
                    <Copy k="hypothesisNote" />
                  </p>
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
                        label={t(`${key}Model`)}
                        value={models[key]}
                        onChange={(value) => setModels((v) => ({ ...v, [key]: value }))}
                        options={COST_MODELS[key].map((value) => ({ value, label: modelLabel(t, value) }))}
                      />
                      <Field
                        label={t(`${key}Source`)}
                        value={evidence[key]}
                        onChange={(e) => setEvidence((v) => ({ ...v, [key]: e.target.value }))}
                        required
                      />
                    </fieldset>
                  ))}
                  {!validAnalysis && (
                    <p className="muted" id="quant-backtest-reason">
                      <Copy k="invalid" />
                    </p>
                  )}
                  <Button
                    type="submit"
                    disabled={action.disabled || !validAnalysis}
                    aria-describedby={validAnalysis ? undefined : 'quant-backtest-reason'}
                  >
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
