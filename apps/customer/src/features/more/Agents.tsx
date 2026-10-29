import { copy, t as copyText, Text } from './copy';
import { agentSessionCopy as sessionCopy } from './agents-session-copy';
import { usePreferences } from '../../shared/preferences';
import './agents-session.css';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Field, Panel, Tabs } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction, presentActionFailure } from './common';
import { Campaigns } from './Campaigns';
import { AgentsCatalogue, refusalWords } from './AgentsCatalogue';
import { agentsCatalogueCopy } from './agents-catalogue-copy';
import { costRange, runCosts, SESSION_AGENT_IDS } from './agents-catalogue';
import { preservePaperHref } from './trade-context';
const uuid = z.string().guid();
const routeSchema = z.object({
  task: z.string(),
  maxOutputTokens: z.number().int().positive().safe(),
  capability: z.enum(['complete', 'stream', 'embed']),
  /** Null when the deployment publishes no rate for the task: every run of it refuses. */
  inputPerMillion: decimalSchema.nullable(),
  outputPerMillion: decimalSchema.nullable(),
  assetId: z.string().min(1),
});
type PricedRoute = z.infer<typeof routeSchema> & { inputPerMillion: string; outputPerMillion: string };
const definition = z.object({
  agentId: z.string(),
  version: z.number().int().positive().safe(),
  enabled: z.boolean(),
  tools: z.array(
    z.object({
      name: z.string(),
      module: z.string(),
      mode: z.enum(['read', 'write']),
      requiresApproval: z.boolean(),
      maxCallsPerSession: z.number().int().nullable(),
    }),
  ),
  limits: z.object({
    maxActionsPerSession: z.number().int().positive().safe(),
    maxOutputTokensPerCall: z.number().int().positive().safe(),
    maxSpendPerSession: decimalSchema.nullable(),
    allowedModules: z.array(z.string()),
    allowedTasks: z.array(z.string()),
  }),
});
const sessionDetailSchema = z
  .object({
    session: z.object({ id: uuid, agentId: z.string(), status: z.enum(['open', 'closed']) }).passthrough(),
    assetId: z.string().min(1),
    windows: z.array(
      z.object({
        windowId: z.string(),
        openedAt: z.string(),
        state: z.enum(['open', 'unpaid', 'settled']),
        amount: decimalSchema.nullable(),
        chargeKey: z.string().nullable(),
      }),
    ),
  })
  .nullable();
type SessionDetail = NonNullable<z.infer<typeof sessionDetailSchema>>;
const sessionSchema = z.object({
  id: uuid,
  agentId: z.string(),
  guardrailVersion: z.number().int().positive().safe(),
  status: z.enum(['open', 'closed']),
  metered: z.boolean(),
  openedAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable(),
});
const actionSchema = z.object({
  id: uuid,
  sessionId: uuid,
  agentId: z.string(),
  sequence: z.number().int().nonnegative().safe(),
  kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
  status: z.enum(['executed', 'refused', 'failed']),
  tool: z.string().nullable(),
  task: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.string().regex(/^\d+$/),
  outputTokens: z.string().regex(/^\d+$/),
  cost: decimalSchema,
  refusalCode: z.string().nullable(),
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.union([z.string(), z.number()])),
  occurredAt: z.string().datetime({ offset: true }),
});
type AgentAction = z.infer<typeof actionSchema>;
const selectedSchema = z.object({ sessionId: uuid, agentId: z.string().min(1) });
type Inspection = { owner: string; id: string; agentId: string };
const inspectionSchema = z.object({ owner: uuid, id: uuid, agentId: z.string().min(1) });
function readInspection(owner: string | null): Inspection | null {
  if (!owner) return null;
  try {
    const saved = inspectionSchema.safeParse(JSON.parse(localStorage.getItem(`intafaced:agents:selected:${owner}`) ?? 'null'));
    return saved.success && saved.data.owner === owner ? saved.data : null;
  } catch {
    return null;
  }
}
function actionList(limit: number, selected?: Inspection | null) {
  return z
    .array(actionSchema)
    .max(limit)
    .superRefine((rows, ctx) => {
      const ids = new Set<string>(),
        sequences = new Set<string>(),
        agents = new Map<string, string>();
      for (const [index, row] of rows.entries()) {
        const sequence = `${row.sessionId}:${row.sequence}`;
        if (
          ids.has(row.id) ||
          sequences.has(sequence) ||
          (agents.has(row.sessionId) && agents.get(row.sessionId) !== row.agentId) ||
          (selected &&
            (row.sessionId !== selected.id || row.agentId !== selected.agentId || (index > 0 && row.sequence <= rows[index - 1]!.sequence)))
        )
          ctx.addIssue({ code: 'custom', path: [index], message: copyText('agents.engine.response.does.not.match.this.session') });
        ids.add(row.id);
        sequences.add(sequence);
        agents.set(row.sessionId, row.agentId);
      }
    });
}
export function Agents({ paper = false }: { paper?: boolean }) {
  const api = useApi(),
    { userId } = useSession(),
    preferences = usePreferences(),
    action = useAction('agents');
  const [tab, setTab] = useState('Catalogue'),
    [agent, setAgent] = useState('navigator'),
    [activeRecord, setActive] = useState<z.infer<typeof sessionSchema> | null>(null),
    [task, setTask] = useState(''),
    [ask, setAsk] = useState(''),
    [reply, setReply] = useState<{ text: string; cost: string; assetId: string; metered: boolean } | null>(null),
    [limit, setLimit] = useState(50),
    [coachAsk, setCoachAsk] = useState(''),
    [coachQuery, setCoachQuery] = useState(''),
    [inspection, setInspection] = useState<Inspection | null>(() => readInspection(userId)),
    [sessionFilter, setSessionFilter] = useState(''),
    [estimating, setEstimating] = useState(false),
    [runs, setRuns] = useState<RunRow[]>([]),
    [runNote, setRunNote] = useState<'same' | null>(null),
    [closing, setClosing] = useState(false),
    [closedNote, setClosedNote] = useState<string | null>(null),
    [closeFailure, setCloseFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [selectNotKept, setSelectNotKept] = useState(false);
  const selectedSession = inspection?.owner === userId ? inspection : null;
  const activeOwner = useRef<string | null>(null);
  const active = activeOwner.current === userId && activeRecord?.agentId === agent ? activeRecord : null;
  const currentContext = useRef({ owner: userId, agent, sessionId: active?.id, task, ask });
  currentContext.current = { owner: userId, agent, sessionId: active?.id, task, ask };
  /** Shows one session in history. A person's own choice is also kept by the service, so it follows them to a reload and
   * another device; a default this device picked (`remember: false`) is not. */
  function inspect(row: Pick<AgentAction, 'sessionId' | 'agentId'>, { remember = true }: { remember?: boolean } = {}) {
    if (!userId) return;
    const next = { owner: userId, id: row.sessionId, agentId: row.agentId };
    setInspection(next);
    try {
      localStorage.setItem(`intafaced:agents:selected:${userId}`, JSON.stringify(next));
    } catch {
      /* Inspection remains available in this view. */
    }
    if (remember)
      void api.mutate('agents', 'session.select', { sessionId: row.sessionId }, selectedSchema).then((res) => setSelectNotKept(!res.ok));
  }
  function contextMatches(expected: typeof currentContext.current) {
    const current = currentContext.current;
    return (
      api.canWrite() &&
      current.owner === expected.owner &&
      current.agent === expected.agent &&
      current.sessionId === expected.sessionId &&
      current.task === expected.task &&
      current.ask === expected.ask
    );
  }
  function changed(reason: 'aborted' | 'uncertain' = 'aborted') {
    const key = reason === 'uncertain' ? 'sameRequest' : 'changed';
    return presentActionFailure({ ok: false as const, reason, message: sessionCopy.t(key) }, (locale) => {
      const current = sessionCopy.forLocale(locale);
      return { message: current.t(key), language: current.languageFor(key) };
    });
  }
  function preflightFailure(
    reason: 'error' | 'aborted',
    key:
      | 'agents.the.agent.guardrails.changed.reload.and.review'
      | 'agents.the.account.changed.review.this.session.again'
      | 'agents.agent.permissions.or.routing.prices.changed.reload'
      | 'agents.the.account.or.session.changed.review.again',
  ) {
    return presentActionFailure({ ok: false as const, reason, message: copyText(key) }, (locale) => {
      const current = copy.forLocale(locale);
      return { message: current.t(key), language: current.languageFor(key) };
    });
  }
  const routes = useResource(
      (signal) => api.query('agents', 'routes.list', undefined, z.array(routeSchema), { signal }),
      `agent-routes:${userId}`,
    ),
    guard = useResource(
      (signal) =>
        api.query(
          'agents',
          'agent.get',
          { agentId: agent },
          definition.nullable().refine((row) => row === null || row.agentId === agent),
          { signal },
        ),
      `agent:${userId}:${agent}`,
    ),
    stored = useResource(
      (signal) => api.query('agents', 'session.selected', undefined, selectedSchema.nullable(), { signal }),
      `agent-selected:${userId}`,
    ),
    log = useResource(
      (signal) => api.query('agents', 'log.mine', { limit }, actionList(limit), { signal }),
      `agent-log:${userId}:${limit}`,
    ),
    sessionLog = useResource(
      (signal) =>
        active
          ? api.query(
              'agents',
              'session.log',
              { sessionId: active.id, limit },
              actionList(limit, { owner: userId!, id: active.id, agentId: active.agentId }),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: [] }),
      `agent-session-log:${userId}:${active?.id}:${limit}`,
    ),
    usage = useResource(
      (signal) =>
        active
          ? api.query(
              'agents',
              'usage.current',
              { sessionId: active.id },
              z.object({ windowId: z.string(), pending: decimalSchema, sessionTotal: decimalSchema, assetId: z.string().min(1) }),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: null }),
      `agent-usage:${userId}:${active?.id}`,
    ),
    selectedHistory = useResource(
      (signal) =>
        selectedSession
          ? api.query('agents', 'session.log', { sessionId: selectedSession.id, limit }, actionList(limit, selectedSession), { signal })
          : Promise.resolve({ ok: true as const, data: [] as AgentAction[] }),
      `agent-inspect-log:${userId}:${selectedSession?.id}:${limit}`,
    ),
    selectedUsage = useResource(
      (signal) =>
        selectedSession
          ? api.query(
              'agents',
              'usage.current',
              { sessionId: selectedSession.id },
              z.object({ windowId: z.string().min(1), pending: decimalSchema, sessionTotal: decimalSchema, assetId: z.string().min(1) }),
              { signal },
            )
          : Promise.resolve({ ok: true as const, data: null }),
      `agent-inspect-usage:${userId}:${selectedSession?.id}`,
    ),
    selectedDetail = useResource(
      (signal) =>
        selectedSession
          ? api.query('agents', 'session.detail', { sessionId: selectedSession.id }, sessionDetailSchema, { signal })
          : Promise.resolve({ ok: true as const, data: null }),
      `agent-inspect-detail:${userId}:${selectedSession?.id}`,
    ),
    coach = useResource(
      (signal) =>
        api.query(
          'agents',
          'coach.session',
          { ask: coachQuery },
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('refuse'),
              reason: z.string(),
              isAdvice: z.literal(false),
              positionsReferenced: z.literal(false),
              citedCount: z.literal(0),
            }),
            z.object({
              status: z.literal('grounded'),
              kind: z.literal('citation'),
              isAdvice: z.literal(false),
              positionsReferenced: z.literal(false),
              citedCount: z.number().int(),
              citations: z.array(z.object({ slug: z.string(), title: z.string() })),
            }),
          ]),
          { signal },
        ),
      `coach:${userId}:${coachQuery}`,
    );
  useEffect(() => {
    setInspection(readInspection(userId));
    setSessionFilter('');
  }, [userId]);
  // The session the person selected, as the service keeps it, wins over this device's copy.
  const storedSelection = stored.resource.status === 'ready' ? stored.resource.data : undefined;
  useEffect(() => {
    if (storedSelection && userId && storedSelection.sessionId !== selectedSession?.id)
      inspect({ sessionId: storedSelection.sessionId, agentId: storedSelection.agentId }, { remember: false });
  }, [userId, storedSelection?.sessionId]);
  // With none selected anywhere yet, history opens on the newest session.
  const newestSession = log.resource.status === 'ready' ? log.resource.data[0] : undefined;
  useEffect(() => {
    if (!selectedSession && stored.resource.status !== 'loading' && !storedSelection && newestSession)
      inspect(newestSession, { remember: false });
  }, [selectedSession, stored.resource.status, storedSelection, newestSession?.sessionId]);
  useEffect(() => {
    activeOwner.current = null;
    setActive(null);
    setReply(null);
    setTask('');
    setEstimating(false);
    setRuns([]);
    setRunNote(null);
  }, [userId, agent]);
  // A refresh of the selected session keeps showing what was read until the new read lands.
  const steadyUsage = useSteady(selectedUsage.resource, selectedSession?.id),
    steadyHistory = useSteady(selectedHistory.resource, selectedSession?.id),
    steadyDetail = useSteady(selectedDetail.resource, selectedSession?.id);
  const defs = guard.resource.status === 'ready' ? guard.resource.data : null,
    available =
      routes.resource.status === 'ready'
        ? routes.resource.data.filter(
            (r): r is PricedRoute =>
              r.capability === 'complete' &&
              r.inputPerMillion !== null &&
              r.outputPerMillion !== null &&
              Boolean(defs?.limits.allowedTasks.includes(r.task)),
          )
        : [],
    selectedRoute = available.find((r) => r.task === (task || available[0]?.task)),
    cap = defs?.limits.maxSpendPerSession;
  return (
    <div className="more-grid agents-room">
      <Tabs
        items={['Catalogue', 'Sessions', 'Activity', 'Coach', 'Product boundaries', 'Campaigns']}
        labels={{
          Catalogue: agentsCatalogueCopy.t('tabCatalogue'),
          Sessions: copyText('agents.sessions'),
          Activity: copyText('agents.activity'),
          Coach: copyText('agents.coach'),
          'Product boundaries': copyText('agents.product.boundaries'),
          Campaigns: copyText('agents.campaigns'),
        }}
        value={tab}
        onChange={setTab}
        label={copyText('agents.agent.sections')}
      />
      {tab === 'Catalogue' ? (
        <AgentsCatalogue
          log={log.resource}
          reload={log.reload}
          onSession={(id) => {
            setAgent(id);
            setTab('Sessions');
          }}
          onCoach={() => setTab('Coach')}
        />
      ) : tab === 'Sessions' ? (
        <>
          <div className="agent-session-journey">
            <Panel title={sessionCopy.t('records')} role="region" aria-label={sessionCopy.t('records')}>
              <p className="muted">{sessionCopy.t('intro')}</p>
              <Button variant="secondary" onClick={log.reload}>
                {sessionCopy.t('refreshRecords')}
              </Button>
              <Read resource={log.resource} retry={log.reload} empty={copyText('agents.no.agent.actions.have.been.recorded')}>
                {(rows) => {
                  const newest = new Map<string, AgentAction>();
                  for (const row of rows) if (!newest.has(row.sessionId)) newest.set(row.sessionId, row);
                  const sessions = [...newest.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
                  const visible = sessions.filter((row) => !sessionFilter || row.agentId === sessionFilter);
                  return (
                    <>
                      <label className="field">
                        <span>{sessionCopy.t('filter')}</span>
                        <select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}>
                          <option value="">{sessionCopy.t('allAgents')}</option>
                          {[...new Set([sessionFilter, ...sessions.map((row) => row.agentId)].filter(Boolean))].map((id) => (
                            <option key={id} value={id} lang="zxx">
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                      {visible.length ? (
                        <DataTable
                          headers={[
                            copyText('agents.agent'),
                            sessionCopy.t('lastAction'),
                            sessionCopy.t('sessionId'),
                            copyText('agents.time'),
                            '',
                          ]}
                          label={sessionCopy.t('recordsTable')}
                        >
                          {visible.map((row) => (
                            <tr key={row.sessionId}>
                              <td lang="zxx">{row.agentId}</td>
                              <td>
                                {sessionCopy.t(row.kind)} · {sessionCopy.t(row.status)}
                              </td>
                              <td lang="zxx">{row.sessionId}</td>
                              <td>{sessionTime(row.occurredAt, preferences)}</td>
                              <td>
                                <Button
                                  variant="secondary"
                                  aria-pressed={selectedSession?.id === row.sessionId}
                                  onClick={() => inspect(row)}
                                >
                                  {sessionCopy.t('inspect')}
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </DataTable>
                      ) : (
                        <p role="status">{sessionCopy.t('noMatch')}</p>
                      )}
                      <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                    </>
                  );
                }}
              </Read>
              <p className="muted">{sessionCopy.t('coverage')}</p>
            </Panel>
            <Panel title={sessionCopy.t('selected')} role="region" aria-label={sessionCopy.t('selected')}>
              {selectedSession ? (
                <>
                  <p>
                    <span lang="zxx">{selectedSession.agentId}</span>
                    <br />
                    <code lang="zxx">{selectedSession.id}</code>
                  </p>
                  <p className="muted">{sessionCopy.t('readOnly')}</p>
                  {selectNotKept ? <p role="status">{sessionCopy.t('selectionLocal')}</p> : null}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      selectedHistory.reload();
                      selectedUsage.reload();
                    }}
                  >
                    {sessionCopy.t('refresh')}
                  </Button>
                  <Read resource={steadyUsage} retry={selectedUsage.reload}>
                    {(usage) =>
                      usage && (
                        <Details
                          items={[
                            [
                              copyText('agents.pending.window.charge'),
                              <span
                                className="agent-exact"
                                lang={preferences.hideBalances ? sessionCopy.forLocale(preferences.language).languageFor('hidden') : 'zxx'}
                              >
                                {preferences.hideBalances ? sessionCopy.t('hidden') : `${displayAmount(usage.pending)} ${usage.assetId}`}
                              </span>,
                            ],
                            [
                              sessionCopy.t('accrued'),
                              <span
                                className="agent-exact"
                                lang={preferences.hideBalances ? sessionCopy.forLocale(preferences.language).languageFor('hidden') : 'zxx'}
                              >
                                {preferences.hideBalances
                                  ? sessionCopy.t('hidden')
                                  : `${displayAmount(usage.sessionTotal)} ${usage.assetId}`}
                              </span>,
                            ],
                          ]}
                        />
                      )
                    }
                  </Read>
                  <p className="muted">{sessionCopy.t('usageBoundary')}</p>
                  <Read resource={steadyDetail} retry={selectedDetail.reload}>
                    {(detail) =>
                      detail ? (
                        <SessionWindows
                          detail={detail}
                          closing={closing}
                          closed={closedNote === detail.session.id}
                          onClose={async () => {
                            setClosing(true);
                            const res = await api.mutate('agents', 'session.close', { sessionId: detail.session.id }, sessionSchema);
                            setClosing(false);
                            if (res.ok) setClosedNote(detail.session.id);
                            else setCloseFailure(res);
                            selectedDetail.reload();
                            selectedUsage.reload();
                            selectedHistory.reload();
                            log.reload();
                          }}
                        />
                      ) : null
                    }
                  </Read>
                  {closeFailure ? <Failure result={closeFailure} /> : null}
                  <Read resource={steadyHistory} retry={selectedHistory.reload} empty={copyText('agents.no.actions.in.this.session')}>
                    {(rows) => (
                      <>
                        <SessionHistory rows={rows} />
                        <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
                      </>
                    )}
                  </Read>
                  <p className="muted">{sessionCopy.t('original')}</p>
                  <p className="muted">{sessionCopy.t('resultBoundary')}</p>
                </>
              ) : (
                <p className="muted">{sessionCopy.t('choose')}</p>
              )}
              {action.feedback}
            </Panel>
          </div>
          <p className="muted">{sessionCopy.t('permission')}</p>
          <div className="more-columns">
            <div>
              <Panel title={copyText('agents.agent.permissions')}>
                <Select label={copyText('agents.product.agent')} value={agent} onChange={setAgent} options={SESSION_AGENT_IDS} />
                <Read resource={guard.resource} retry={guard.reload} empty={copyText('agents.this.agent.is.not.registered.in.the')}>
                  {(g) =>
                    g ? (
                      <>
                        <Details
                          items={[
                            [copyText('agents.agent'), <span lang="zxx">{g.agentId}</span>],
                            [copyText('agents.enabled'), copyText(g.enabled ? 'common.yes' : 'common.no')],
                            [copyText('agents.guardrail.version'), g.version],
                            [copyText('agents.actions.per.session'), g.limits.maxActionsPerSession],
                            [copyText('agents.output.token.cap'), g.limits.maxOutputTokensPerCall],
                            [
                              copyText('agents.spend.cap'),
                              cap && selectedRoute
                                ? copyText('agents.per.session', { amount: displayAmount(cap), asset: selectedRoute.assetId })
                                : copyText('agents.a.spend.cap.or.its.fee.asset'),
                            ],
                          ]}
                        />
                        <DataTable
                          headers={[copyText('agents.tool'), copyText('agents.access'), copyText('agents.approval')]}
                          label={copyText('agents.agent.tool.permissions')}
                        >
                          {g.tools.map((t) => (
                            <tr key={t.name}>
                              <td>{t.name}</td>
                              <td>{t.mode}</td>
                              <td>{t.requiresApproval ? copyText('agents.required') : copyText('agents.no.additional.approval')}</td>
                            </tr>
                          ))}
                        </DataTable>
                        <p className="muted">
                          <Text k="agents.opening.a.session.permits.engine.tasks.within" />
                        </p>
                        <Button
                          disabled={
                            action.disabled ||
                            Boolean(active && active.status === 'open') ||
                            !g.enabled ||
                            !selectedRoute ||
                            !cap ||
                            parseAmount(cap) <= 0n
                          }
                          onClick={() => {
                            if (!selectedRoute || !cap) return;
                            const expected = { ...currentContext.current };
                            action.stage({
                              title: () => copyText('agents.review.agent.session'),
                              reference: agent,
                              confirm: () => copyText('agents.open.agent.session'),
                              success: () => copyText('agents.agent.session.opened'),
                              content: () => (
                                <>
                                  <p role="note">{agentsCatalogueCopy.t('costOpenNotice')}</p>
                                  <Details
                                    items={[
                                      [copyText('agents.agent'), <span lang="zxx">{g.agentId}</span>],
                                      [
                                        copyText('agents.maximum.spend'),
                                        copyText('agents.maximum.per.session', { amount: cap, asset: selectedRoute.assetId }),
                                      ],
                                      [
                                        copyText('agents.input.rate'),
                                        copyText('agents.million.tokens', {
                                          amount: selectedRoute.inputPerMillion,
                                          asset: selectedRoute.assetId,
                                        }),
                                      ],
                                      [
                                        copyText('agents.output.rate'),
                                        copyText('agents.million.tokens', {
                                          amount: selectedRoute.outputPerMillion,
                                          asset: selectedRoute.assetId,
                                        }),
                                      ],
                                      [copyText('agents.tool.authority'), g.tools.map((t) => `${t.name}: ${t.mode}`).join('\n')],
                                    ]}
                                  />
                                </>
                              ),
                              run: async (canDispatch) => {
                                if (!contextMatches(expected)) return changed();
                                const fresh = await api.query('agents', 'agent.get', { agentId: agent }, definition.nullable());
                                if (!fresh.ok) return fresh;
                                if (
                                  !fresh.data ||
                                  fresh.data.agentId !== agent ||
                                  fresh.data.version !== g.version ||
                                  !fresh.data.enabled ||
                                  fresh.data.limits.maxSpendPerSession !== cap
                                )
                                  return preflightFailure('error', 'agents.the.agent.guardrails.changed.reload.and.review');
                                if (!canDispatch() || !contextMatches(expected))
                                  return preflightFailure('aborted', 'agents.the.account.changed.review.this.session.again');
                                const res = await api.mutate(
                                  'agents',
                                  'session.open',
                                  { agentId: agent },
                                  sessionSchema.refine(
                                    (s) =>
                                      s.agentId === agent &&
                                      s.guardrailVersion === g.version &&
                                      s.status === 'open' &&
                                      s.closedAt === null &&
                                      Number.isFinite(Date.parse(s.openedAt)),
                                  ),
                                );
                                if (res.ok && action.isCurrent() && contextMatches(expected)) {
                                  activeOwner.current = expected.owner;
                                  setActive(res.data);
                                  inspect({ sessionId: res.data.id, agentId: res.data.agentId });
                                }
                                return res;
                              },
                              done: log.reload,
                            });
                          }}
                        >
                          <Text k="agents.review.session" />
                        </Button>
                        <Button variant="secondary" aria-expanded={estimating} onClick={() => setEstimating((open) => !open)}>
                          {agentsCatalogueCopy.t('estimateButton')}
                        </Button>
                        {estimating ? (
                          <CostEstimate
                            cap={cap ?? null}
                            assetId={selectedRoute?.assetId ?? null}
                            history={
                              log.resource.status === 'ready' && selectedRoute
                                ? {
                                    range: costRange(runCosts(log.resource.data, agent, selectedRoute.task)),
                                    whole: log.resource.data.length < limit,
                                  }
                                : undefined
                            }
                          />
                        ) : null}
                      </>
                    ) : null
                  }
                </Read>
              </Panel>
              <Panel title={copyText('agents.published.routing.prices')}>
                <Read resource={routes.resource} retry={routes.reload} empty={copyText('agents.no.engine.routes.are.published')}>
                  {(rows) => (
                    <DataTable
                      headers={[
                        copyText('agents.task'),
                        copyText('agents.capability'),
                        copyText('agents.input.million'),
                        copyText('agents.output.million'),
                      ]}
                      label={copyText('agents.published.engine.routing.prices')}
                    >
                      {rows.map((r) => (
                        <tr key={r.task}>
                          <td>{r.task}</td>
                          <td>{r.capability}</td>
                          <td>
                            {r.inputPerMillion === null
                              ? agentsCatalogueCopy.t('rateBlank')
                              : `${displayAmount(r.inputPerMillion)} ${r.assetId}`}
                          </td>
                          <td>
                            {r.outputPerMillion === null
                              ? agentsCatalogueCopy.t('rateBlank')
                              : `${displayAmount(r.outputPerMillion)} ${r.assetId}`}
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                </Read>
              </Panel>
            </div>
            <Panel title={copyText('agents.session.workspace')} role="region" aria-label={copyText('agents.session.workspace')}>
              {active ? (
                <>
                  <p>
                    <code data-testid="session-id" lang="zxx">
                      {active.id}
                    </code>{' '}
                    · {active.status}
                  </p>
                  <Read resource={usage.resource} retry={usage.reload}>
                    {(u) =>
                      u ? (
                        <Details
                          items={[
                            [copyText('agents.pending.window.charge'), `${u.pending} ${u.assetId}`],
                            [copyText('agents.session.spend'), `${u.sessionTotal} ${u.assetId}`],
                          ]}
                        />
                      ) : null
                    }
                  </Read>
                  <Select
                    label={copyText('agents.allowed.engine.task')}
                    value={task || available[0]?.task || ''}
                    onChange={setTask}
                    options={available.map((r) => r.task)}
                  />
                  <TextArea label={agentsCatalogueCopy.t('askAgent')} value={ask} onChange={setAsk} maxLength={200000} />
                  <Button
                    disabled={action.disabled || active.status !== 'open' || !ask.trim() || !selectedRoute}
                    onClick={() => {
                      if (!selectedRoute || !defs) return;
                      const requestId = crypto.randomUUID();
                      const expected = { ...currentContext.current };
                      action.stage({
                        title: () => agentsCatalogueCopy.t('ceilingTitle'),
                        confirm: () =>
                          cap
                            ? agentsCatalogueCopy.t('runUpTo', { amount: displayAmount(cap), asset: selectedRoute.assetId })
                            : copyText('agents.run.engine.request'),
                        success: () => copyText('agents.engine.response.received'),
                        content: () => (
                          <>
                            <p role="note">
                              <strong>{agentsCatalogueCopy.t('costTitle')}.</strong> {agentsCatalogueCopy.t('costNotice')}{' '}
                              {agentsCatalogueCopy.t('sandboxNotice')}
                            </p>
                            <Details
                              items={[
                                [copyText('agents.task'), <span lang="zxx">{selectedRoute.task}</span>],
                                [copyText('agents.request'), <span lang="und">{ask}</span>],
                                [
                                  copyText('agents.spend.ceiling'),
                                  cap == null
                                    ? copyText('agents.a.spend.cap.or.its.fee.asset')
                                    : copyText('agents.for.the.entire.session', { amount: cap, asset: selectedRoute.assetId }),
                                ],
                                [
                                  copyText('agents.output.cap'),
                                  Math.min(defs.limits.maxOutputTokensPerCall, selectedRoute.maxOutputTokens),
                                ],
                              ]}
                            />
                          </>
                        ),
                        reference: requestId,
                        run: async (canDispatch) => {
                          if (!contextMatches(expected)) return changed();
                          const [freshGuard, freshRoutes] = await Promise.all([
                            api.query('agents', 'agent.get', { agentId: agent }, definition.nullable()),
                            api.query('agents', 'routes.list', undefined, z.array(routeSchema)),
                          ]);
                          if (!freshGuard.ok) return freshGuard;
                          if (!freshRoutes.ok) return freshRoutes;
                          const freshRoute = freshRoutes.data.find(
                            (row) => row.task === selectedRoute.task && row.capability === 'complete',
                          );
                          if (
                            !freshGuard.data?.enabled ||
                            freshGuard.data.agentId !== agent ||
                            freshGuard.data.agentId !== agent ||
                            freshGuard.data.version !== active.guardrailVersion ||
                            freshGuard.data.limits.maxSpendPerSession !== cap ||
                            !freshGuard.data.limits.allowedTasks.includes(selectedRoute.task) ||
                            freshGuard.data.limits.maxOutputTokensPerCall !== defs.limits.maxOutputTokensPerCall ||
                            !freshRoute ||
                            freshRoute.assetId !== selectedRoute.assetId ||
                            freshRoute.inputPerMillion !== selectedRoute.inputPerMillion ||
                            freshRoute.outputPerMillion !== selectedRoute.outputPerMillion ||
                            freshRoute.maxOutputTokens !== selectedRoute.maxOutputTokens
                          )
                            return preflightFailure('error', 'agents.agent.permissions.or.routing.prices.changed.reload');
                          if (!canDispatch() || !contextMatches(expected))
                            return preflightFailure('aborted', 'agents.the.account.or.session.changed.review.again');
                          // The run row exists before the engine is called, and says so.
                          const row: RunRow = {
                            requestId,
                            task: selectedRoute.task,
                            ask,
                            status: 'running',
                            cost: null,
                            assetId: selectedRoute.assetId,
                            code: null,
                          };
                          setRunNote(null);
                          setRuns((current) => [row, ...current]);
                          const res = await api.mutate(
                            'agents',
                            'run.complete',
                            {
                              sessionId: active.id,
                              requestId,
                              task: selectedRoute.task,
                              messages: [{ role: 'user', content: ask }],
                              maxOutputTokens: Math.min(defs.limits.maxOutputTokensPerCall, selectedRoute.maxOutputTokens),
                            },
                            z
                              .object({
                                text: z.string(),
                                inputTokens: z.number().int(),
                                outputTokens: z.number().int(),
                                cost: decimalSchema,
                                assetId: z.string(),
                                metered: z.boolean(),
                                action: actionSchema,
                              })
                              .refine(
                                (row) =>
                                  row.assetId === selectedRoute.assetId &&
                                  row.action.sessionId === active.id &&
                                  row.action.agentId === agent &&
                                  row.action.task === selectedRoute.task &&
                                  row.action.kind === 'completion' &&
                                  row.action.status === 'executed' &&
                                  Number.isSafeInteger(row.inputTokens) &&
                                  row.inputTokens >= 0 &&
                                  Number.isSafeInteger(row.outputTokens) &&
                                  row.outputTokens >= 0 &&
                                  BigInt(row.inputTokens) === BigInt(row.action.inputTokens) &&
                                  BigInt(row.outputTokens) === BigInt(row.action.outputTokens) &&
                                  parseAmount(row.cost) === parseAmount(row.action.cost) &&
                                  (row.metered || parseAmount(row.cost) === 0n),
                                copyText('agents.engine.response.does.not.match.this.session'),
                              ),
                          );
                          setRuns((current) =>
                            current.map((entry) =>
                              entry.requestId !== requestId
                                ? entry
                                : res.ok
                                  ? { ...entry, status: 'completed', cost: res.data.cost }
                                  : { ...entry, status: res.reason === 'uncertain' ? 'unknown' : 'refused', code: res.message },
                            ),
                          );
                          if (res.ok && action.isCurrent() && contextMatches(expected)) setReply(res.data);
                          return res;
                        },
                        done: () => {
                          usage.reload();
                          sessionLog.reload();
                          log.reload();
                        },
                      });
                    }}
                  >
                    {agentsCatalogueCopy.t('run')}
                  </Button>
                  <Runs
                    rows={runs}
                    onSendAgain={async (row) => {
                      // The same request id is the same run: the service returns it or names it, and charges once.
                      const res = await api.mutate(
                        'agents',
                        'run.complete',
                        { sessionId: active.id, requestId: row.requestId, task: row.task, messages: [{ role: 'user', content: row.ask }] },
                        z.object({ cost: decimalSchema, text: z.string() }).passthrough(),
                      );
                      if (res.ok || /request_id_replay/.test(res.message)) setRunNote('same');
                      else
                        setRuns((current) =>
                          current.map((entry) => (entry.requestId === row.requestId ? { ...entry, code: res.message } : entry)),
                        );
                    }}
                  />
                  {runNote ? <p role="status">{agentsCatalogueCopy.t('sameRequest')}</p> : null}
                  {reply && (
                    <>
                      <section role="region" aria-label={agentsCatalogueCopy.t('reply')}>
                        <h3>{agentsCatalogueCopy.t('reply')}</h3>
                        <p data-testid="more-body" className="more-body" lang="und">
                          {reply.text}
                        </p>
                      </section>
                      <p className="muted">
                        {reply.metered
                          ? copyText('agents.metered.cost', { value1: reply.cost, value2: reply.assetId })
                          : copyText('agents.the.service.labeled.this.response.unmetered')}{' '}
                        <Text k="agents.engine.text.is.a.response.to.your" />
                      </p>
                    </>
                  )}
                  <Button
                    variant="secondary"
                    disabled={action.disabled || active.status !== 'open'}
                    onClick={() => {
                      const expected = { ...currentContext.current };
                      action.stage({
                        title: () => copyText('agents.close.agent.session'),
                        confirm: () => copyText('agents.settle.and.close.session'),
                        success: () => copyText('agents.session.closure.received'),
                        content: () => (
                          <p>
                            <Text k="agents.the.service.settles.outstanding.metered.windows.before" />
                          </p>
                        ),
                        reference: active.id,
                        run: async (canDispatch) => {
                          if (!canDispatch() || !contextMatches(expected)) return changed();
                          const res = await api.mutate(
                            'agents',
                            'session.close',
                            { sessionId: active.id },
                            sessionSchema.refine(
                              (row) =>
                                row.id === active.id &&
                                row.agentId === agent &&
                                row.status === 'closed' &&
                                row.closedAt !== null &&
                                Number.isFinite(Date.parse(row.closedAt)) &&
                                Date.parse(row.closedAt) >= Date.parse(row.openedAt),
                              copyText('agents.session.closure.does.not.match.the.active'),
                            ),
                          );
                          if (res.ok && action.isCurrent() && contextMatches(expected)) setActive(res.data);
                          return res;
                        },
                        done: () => {
                          usage.reload();
                          sessionLog.reload();
                          log.reload();
                        },
                      });
                    }}
                  >
                    <Text k="agents.review.session.closure" />
                  </Button>
                  <Read resource={sessionLog.resource} retry={sessionLog.reload} empty={copyText('agents.no.actions.in.this.session')}>
                    {(rows) => <Activity rows={rows} />}
                  </Read>
                </>
              ) : (
                <p className="muted">
                  <Text k="agents.review.a.registered.agent.and.open.its" />
                </p>
              )}
            </Panel>
          </div>
        </>
      ) : tab === 'Activity' ? (
        <Panel title={copyText('agents.your.agent.action.log')}>
          <Read resource={log.resource} retry={log.reload} empty={copyText('agents.no.agent.actions.have.been.recorded')}>
            {(rows) => (
              <>
                <Activity rows={rows} />
                <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
              </>
            )}
          </Read>
          <p className="muted">
            <Text k="agents.the.log.reports.exact.costs.but.does" />
          </p>
        </Panel>
      ) : tab === 'Coach' ? (
        <Panel title={copyText('agents.curriculum.coach')}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCoachQuery(coachAsk);
            }}
          >
            <Field
              label={copyText('agents.learning.question')}
              value={coachAsk}
              onChange={(e) => setCoachAsk(e.target.value)}
              maxLength={2000}
            />
            <Button type="submit" variant="secondary">
              <Text k="agents.find.grounded.lessons" />
            </Button>
          </form>
          <Read resource={coach.resource} retry={coach.reload}>
            {(c) =>
              c.status === 'refuse' ? (
                <p role="status">
                  <Text k="agents.the.coach.cannot.ground.this.request" />
                  {c.reason}
                  <Text k="agents.nothing.was.generated" />
                </p>
              ) : (
                <>
                  <p>
                    {c.citedCount}
                    <Text k="agents.curriculum.citations" />
                  </p>
                  <ul>
                    {c.citations.map((r) => (
                      <li key={r.slug}>
                        <a className="text-link" href={`/academy/${encodeURIComponent(r.slug)}`}>
                          {r.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </Read>
        </Panel>
      ) : tab === 'Campaigns' ? (
        <Campaigns />
      ) : (
        <Panel title={copyText('agents.product.agent.boundaries')}>
          <Details
            items={[
              [
                copyText('agents.navigator.and.support.data.sessions'),
                copyText('agents.the.runsession.contracts.require.a.caller.supplied'),
              ],
              [copyText('agents.market.scanner'), copyText('agents.signal.ranking.also.requires.a.sealed.input')],
              [copyText('agents.merchant.watcher'), copyText('agents.a.published.threshold.minimum.sample.count.rail')],
              [copyText('agents.copy.intelligence'), copyText('agents.leader.fixtures.must.come.from.the.live')],
              [copyText('agents.portfolio.planner'), copyText('agents.the.service.portfolio.port.is.unconnected.no')],
              [copyText('agents.launch.and.risk.drafts'), copyText('agents.draft.assessment.is.not.issuance.screening.list')],
            ]}
          />
          <a className="text-link" href={preservePaperHref('/trade/copy', paper)}>
            <Text k="agents.open.copy" />
          </a>
          <a className="text-link" href="/support">
            <Text k="agents.open.support" />
          </a>
        </Panel>
      )}
      {action.dialog}
    </div>
  );
}
function Activity({ rows }: { rows: z.infer<typeof actionSchema>[] }) {
  return (
    <DataTable
      headers={[
        copyText('agents.time'),
        copyText('agents.agent.session'),
        copyText('agents.action'),
        copyText('agents.outcome'),
        copyText('agents.cost'),
      ]}
      label={copyText('agents.agent.audit.activity')}
    >
      {rows.map((r) => (
        <tr key={r.id}>
          <td>{r.occurredAt}</td>
          <td>
            {r.agentId}
            <small className="more-receipt">{r.sessionId}</small>
          </td>
          <td>
            {r.sequence}. {r.kind}
            <small>{r.tool ?? r.task ?? ''}</small>
          </td>
          <td>
            {r.status}
            {r.refusalCode && <small>{r.refusalCode}</small>}
          </td>
          <td>
            {r.cost}
            <Text k="agents.asset.not.supplied.by.log" />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

function sessionTime(at: string, preferences: ReturnType<typeof usePreferences>) {
  return new Intl.DateTimeFormat(preferences.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
  }).format(new Date(at));
}
function SessionHistory({ rows }: { rows: AgentAction[] }) {
  const preferences = usePreferences();
  const authored = sessionCopy.forLocale(preferences.language);
  return (
    <ol className="agent-session-history" aria-label={copyText('agents.agent.audit.activity')}>
      {rows.map((row) => (
        <li key={row.id}>
          <strong>
            <span lang={authored.languageFor(row.kind)}>{authored.t(row.kind)}</span> ·{' '}
            <span lang={authored.languageFor(row.status)}>{authored.t(row.status)}</span>
          </strong>
          <small lang="zxx">
            {row.sequence} · {row.id}
          </small>
          <small>
            <time dateTime={row.occurredAt}>{sessionTime(row.occurredAt, preferences)}</time>
          </small>
          <small lang="zxx">{row.tool ?? row.task ?? ''}</small>
          <dl>
            <div>
              <dt>{sessionCopy.t('input')}</dt>
              <dd lang="zxx">{row.inputTokens}</dd>
            </div>
            <div>
              <dt>{sessionCopy.t('output')}</dt>
              <dd lang="zxx">{row.outputTokens}</dd>
            </div>
            <div>
              <dt>{copyText('agents.cost')}</dt>
              <dd lang={preferences.hideBalances ? sessionCopy.forLocale(preferences.language).languageFor('hidden') : 'zxx'}>
                {preferences.hideBalances ? sessionCopy.t('hidden') : displayAmount(row.cost)}
              </dd>
            </div>
          </dl>
          <small>
            <Text k="agents.asset.not.supplied.by.log" />
          </small>
          {row.refusalCode && (
            <small>
              {refusalWords(row.refusalCode)} <span lang="zxx">{row.refusalCode}</span>
            </small>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * What one run in a new session can cost before it is started. The worst case is
 * the session's spend cap: the figure the runtime's cap check refuses above,
 * before the engine is called. The expected range comes only from this
 * person's own completed runs of the task; without any there is none. The
 * log names no asset, so the range names none either.
 */
function CostEstimate({
  cap,
  assetId,
  history,
}: {
  cap: string | null;
  assetId: string | null;
  /** This person's runs from the loaded log page; `whole` when that page holds their entire log. */
  history: { range: { low: string; high: string } | null; whole: boolean } | undefined;
}) {
  const { t } = agentsCatalogueCopy.useCopy();
  return (
    <section role="region" aria-label={t('estimateTitle')}>
      <h3>{t('estimateTitle')}</h3>
      <p data-testid="worst-case">
        {cap && assetId && parseAmount(cap) > 0n ? t('worstCase', { amount: displayAmount(cap), asset: assetId }) : t('worstCaseNoCap')}
      </p>
      <p className="muted">{t('worstCaseBasis')}</p>
      <p>
        {history === undefined
          ? t('historyUnloaded')
          : history.range
            ? t('historyRange', { low: displayAmount(history.range.low), high: displayAmount(history.range.high) })
            : history.whole
              ? t('historyNone')
              : t('historyNotLoaded')}
      </p>
    </section>
  );
}

type RunRow = {
  requestId: string;
  task: string;
  ask: string;
  status: 'running' | 'completed' | 'refused' | 'unknown';
  cost: string | null;
  assetId: string;
  /** The service's refusal, as its key, when the run did not complete. */
  code: string | null;
};

/** This session's runs on this page, newest first: each row exists before the engine is called. */
function Runs({ rows, onSendAgain }: { rows: RunRow[]; onSendAgain: (row: RunRow) => void }) {
  const { t } = agentsCatalogueCopy.useCopy();
  const preferences = usePreferences();
  return (
    <DataTable headers={[t('runRequest'), t('runTask'), t('runStatus'), t('runCost'), '']} label={t('runs')}>
      {rows.map((row) => (
        <tr key={row.requestId}>
          <td lang="zxx">{row.requestId}</td>
          <td lang="zxx">{row.task}</td>
          <td>
            {t(`run_${row.status}`)}
            {row.code ? <small lang="zxx"> {row.code}</small> : null}
          </td>
          <td data-testid="run-cost">
            {row.cost === null
              ? row.status === 'refused'
                ? `0 ${row.assetId}`
                : '—'
              : preferences.hideBalances
                ? '••••'
                : `${displayAmount(row.cost)} ${row.assetId}`}
          </td>
          <td>
            {row.status === 'completed' ? (
              <Button variant="secondary" onClick={() => onSendAgain(row)}>
                {t('sendAgain')}
              </Button>
            ) : null}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

/** One recorded session's usage windows, and closing it: open windows settle once, and a closed session takes nothing more. */
function SessionWindows({
  detail,
  closing,
  closed,
  onClose,
}: {
  detail: SessionDetail;
  closing: boolean;
  closed: boolean;
  onClose: () => void;
}) {
  const { t } = agentsCatalogueCopy.useCopy();
  const preferences = usePreferences();
  return (
    <>
      <DataTable headers={[t('windowId'), t('windowState'), t('windowCost'), t('chargeKey')]} label={t('usageWindows')}>
        {detail.windows.map((window) => (
          <tr key={window.windowId}>
            <td lang="zxx">{window.windowId}</td>
            <td>{t(`window_${window.state}`)}</td>
            <td data-testid="window-cost">
              {window.amount === null ? '—' : preferences.hideBalances ? '••••' : `${displayAmount(window.amount)} ${detail.assetId}`}
            </td>
            <td data-testid="charge-key" lang="zxx">
              {window.chargeKey ?? '—'}
            </td>
          </tr>
        ))}
      </DataTable>
      {detail.session.status === 'open' ? (
        <Button variant="secondary" disabled={closing} onClick={onClose}>
          {t('closeSession')}
        </Button>
      ) : (
        <p>{t('sessionClosed')}</p>
      )}
      {closed ? <p role="status">{t('closedSettled')}</p> : null}
    </>
  );
}

/** The last ready read for the same key while a refresh of it loads; a new key starts from loading. */
function useSteady<T>(resource: Resource<T>, key: string | undefined): Resource<T> {
  const last = useRef<{ key: string | undefined; resource: Resource<T> } | null>(null);
  if (resource.status === 'ready') last.current = { key, resource };
  const kept = last.current;
  return resource.status === 'loading' && kept && kept.key === key ? kept.resource : resource;
}
