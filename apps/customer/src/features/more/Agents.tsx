import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel, Tabs } from '../../shared/ui';
import { Details, Limit, Read, Select, TextArea, useAction } from './common';
import { Campaigns } from './Campaigns';
const uuid = z.string().uuid();
const routeSchema = z.object({
  task: z.string(),
  maxOutputTokens: z.number().int(),
  capability: z.enum(['complete', 'stream', 'embed']),
  inputPerMillion: decimalSchema,
  outputPerMillion: decimalSchema,
  assetId: z.string().min(1),
});
const definition = z.object({
  agentId: z.string(),
  version: z.number().int(),
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
    maxActionsPerSession: z.number().int(),
    maxOutputTokensPerCall: z.number().int(),
    maxSpendPerSession: decimalSchema.nullable(),
    allowedModules: z.array(z.string()),
    allowedTasks: z.array(z.string()),
  }),
});
const sessionSchema = z.object({
  id: uuid,
  agentId: z.string(),
  guardrailVersion: z.number().int(),
  status: z.enum(['open', 'closed']),
  metered: z.boolean(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
});
const actionSchema = z.object({
  id: uuid,
  sessionId: uuid,
  agentId: z.string(),
  sequence: z.number().int(),
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
  messageParams: z.record(z.union([z.string(), z.number()])),
  occurredAt: z.string(),
});
export function Agents() {
  const api = useApi(),
    { userId } = useSession(),
    action = useAction('agents');
  const [tab, setTab] = useState('Sessions'),
    [agent, setAgent] = useState('navigator'),
    [active, setActive] = useState<z.infer<typeof sessionSchema> | null>(null),
    [task, setTask] = useState(''),
    [ask, setAsk] = useState(''),
    [reply, setReply] = useState<{ text: string; cost: string; assetId: string; metered: boolean } | null>(null),
    [limit, setLimit] = useState(50),
    [coachAsk, setCoachAsk] = useState(''),
    [coachQuery, setCoachQuery] = useState('');
  const routes = useResource(
      (signal) => api.query('agents', 'routes.list', undefined, z.array(routeSchema), { signal }),
      `agent-routes:${userId}`,
    ),
    guard = useResource(
      (signal) => api.query('agents', 'agent.get', { agentId: agent }, definition.nullable(), { signal }),
      `agent:${userId}:${agent}`,
    ),
    log = useResource(
      (signal) => api.query('agents', 'log.mine', { limit }, z.array(actionSchema), { signal }),
      `agent-log:${userId}:${limit}`,
    ),
    sessionLog = useResource(
      (signal) =>
        active
          ? api.query('agents', 'session.log', { sessionId: active.id, limit }, z.array(actionSchema), { signal })
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
    setActive(null);
    setReply(null);
    setTask('');
  }, [userId, agent]);
  const defs = guard.resource.status === 'ready' ? guard.resource.data : null,
    available =
      routes.resource.status === 'ready'
        ? routes.resource.data.filter((r) => r.capability === 'complete' && defs?.limits.allowedTasks.includes(r.task))
        : [],
    selectedRoute = available.find((r) => r.task === (task || available[0]?.task)),
    cap = defs?.limits.maxSpendPerSession;
  return (
    <div className="more-grid">
      <Tabs
        items={['Sessions', 'Activity', 'Coach', 'Product boundaries', 'Campaigns']}
        value={tab}
        onChange={setTab}
        label="Agent sections"
      />
      {tab === 'Sessions' ? (
        <div className="more-columns">
          <div>
            <Panel title="Agent permissions">
              <Select
                label="Product agent"
                value={agent}
                onChange={setAgent}
                options={['navigator', 'support', 'scanner', 'merchant', 'copy-intel']}
              />
              <Read resource={guard.resource} retry={guard.reload} empty="This agent is not registered in the service">
                {(g) =>
                  g ? (
                    <>
                      <Details
                        items={[
                          ['Agent', g.agentId],
                          ['Enabled', g.enabled ? 'Yes' : 'No'],
                          ['Guardrail version', g.version],
                          ['Actions per session', g.limits.maxActionsPerSession],
                          ['Output token cap', g.limits.maxOutputTokensPerCall],
                          [
                            'Spend cap',
                            cap && selectedRoute
                              ? `${displayAmount(cap)} ${selectedRoute.assetId} per session`
                              : 'A spend cap or its fee asset is unavailable',
                          ],
                        ]}
                      />
                      <DataTable headers={['Tool', 'Access', 'Approval']} label="Agent tool permissions">
                        {g.tools.map((t) => (
                          <tr key={t.name}>
                            <td>{t.name}</td>
                            <td>{t.mode}</td>
                            <td>{t.requiresApproval ? 'Required' : 'No additional approval'}</td>
                          </tr>
                        ))}
                      </DataTable>
                      <p className="muted">
                        Opening a session permits engine tasks within these server guardrails. It grants no undeclared trading or withdrawal
                        tool.
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
                          action.stage({
                            title: 'Review agent session',
                            confirm: 'Open agent session',
                            success: 'Agent session opened',
                            content: (
                              <Details
                                items={[
                                  ['Agent', g.agentId],
                                  ['Maximum spend', `${cap} ${selectedRoute.assetId} maximum per session`],
                                  ['Input rate', `${selectedRoute.inputPerMillion} ${selectedRoute.assetId} / million tokens`],
                                  ['Output rate', `${selectedRoute.outputPerMillion} ${selectedRoute.assetId} / million tokens`],
                                  ['Tool authority', g.tools.map((t) => `${t.name}: ${t.mode}`).join('\n')],
                                ]}
                              />
                            ),
                            run: async (canDispatch) => {
                              const fresh = await api.query('agents', 'agent.get', { agentId: agent }, definition.nullable());
                              if (!fresh.ok) return fresh;
                              if (
                                !fresh.data ||
                                fresh.data.version !== g.version ||
                                !fresh.data.enabled ||
                                fresh.data.limits.maxSpendPerSession !== cap
                              )
                                return { ok: false, reason: 'error', message: 'The agent guardrails changed. Reload and review again.' };
                              if (!canDispatch())
                                return { ok: false, reason: 'aborted', message: 'The account changed. Review this session again.' };
                              const res = await api.mutate(
                                'agents',
                                'session.open',
                                { agentId: agent },
                                sessionSchema.refine((s) => s.agentId === agent && s.guardrailVersion === g.version),
                              );
                              if (res.ok && action.isCurrent()) setActive(res.data);
                              return res;
                            },
                            done: log.reload,
                          });
                        }}
                      >
                        Review session
                      </Button>
                    </>
                  ) : null
                }
              </Read>
            </Panel>
            <Panel title="Published routing prices">
              <Read resource={routes.resource} retry={routes.reload} empty="No engine routes are published">
                {(rows) => (
                  <DataTable
                    headers={['Task', 'Capability', 'Input / million', 'Output / million']}
                    label="Published engine routing prices"
                  >
                    {rows.map((r) => (
                      <tr key={r.task}>
                        <td>{r.task}</td>
                        <td>{r.capability}</td>
                        <td>
                          {displayAmount(r.inputPerMillion)} {r.assetId}
                        </td>
                        <td>
                          {displayAmount(r.outputPerMillion)} {r.assetId}
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </Read>
            </Panel>
          </div>
          <Panel title="Session workspace">
            {active ? (
              <>
                <p>
                  <code>{active.id}</code> · {active.status}
                </p>
                <Read resource={usage.resource} retry={usage.reload}>
                  {(u) =>
                    u ? (
                      <Details
                        items={[
                          ['Pending window charge', `${u.pending} ${u.assetId}`],
                          ['Session spend', `${u.sessionTotal} ${u.assetId}`],
                        ]}
                      />
                    ) : null
                  }
                </Read>
                <Select
                  label="Allowed engine task"
                  value={task || available[0]?.task || ''}
                  onChange={setTask}
                  options={available.map((r) => r.task)}
                />
                <TextArea label="Task request" value={ask} onChange={setAsk} maxLength={200000} />
                <Button
                  disabled={action.disabled || active.status !== 'open' || !ask.trim() || !selectedRoute}
                  onClick={() => {
                    if (!selectedRoute || !defs) return;
                    const requestId = crypto.randomUUID();
                    action.stage({
                      title: 'Review metered engine request',
                      confirm: 'Run engine request',
                      success: 'Engine response received',
                      content: (
                        <Details
                          items={[
                            ['Task', selectedRoute.task],
                            ['Request', ask],
                            ['Spend ceiling', `${cap} ${selectedRoute.assetId} for the entire session`],
                            ['Output cap', Math.min(defs.limits.maxOutputTokensPerCall, selectedRoute.maxOutputTokens)],
                          ]}
                        />
                      ),
                      run: async (canDispatch) => {
                        const [freshGuard, freshRoutes] = await Promise.all([
                          api.query('agents', 'agent.get', { agentId: agent }, definition.nullable()),
                          api.query('agents', 'routes.list', undefined, z.array(routeSchema)),
                        ]);
                        if (!freshGuard.ok) return freshGuard;
                        if (!freshRoutes.ok) return freshRoutes;
                        const freshRoute = freshRoutes.data.find((row) => row.task === selectedRoute.task && row.capability === 'complete');
                        if (
                          !freshGuard.data?.enabled ||
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
                          return {
                            ok: false,
                            reason: 'error',
                            message: 'Agent permissions or routing prices changed. Reload and review this request again.',
                          };
                        if (!canDispatch())
                          return { ok: false, reason: 'aborted', message: 'The account or session changed. Review again.' };
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
                                row.assetId === selectedRoute.assetId && row.action.sessionId === active.id && row.action.agentId === agent,
                              'Engine response does not match this session and reviewed fee asset',
                            ),
                        );
                        if (res.ok && action.isCurrent()) setReply(res.data);
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
                  Review engine request
                </Button>
                {reply && (
                  <>
                    <p className="more-body">{reply.text}</p>
                    <p className="muted">
                      {reply.metered ? `Metered cost: ${reply.cost} ${reply.assetId}` : 'The service labeled this response unmetered.'}{' '}
                      Engine text is a response to your request; no order or withdrawal is executed by displaying it.
                    </p>
                  </>
                )}
                <Button
                  variant="secondary"
                  disabled={action.disabled || active.status !== 'open'}
                  onClick={() =>
                    action.stage({
                      title: 'Close agent session',
                      confirm: 'Settle and close session',
                      success: 'Session closure received',
                      content: (
                        <p>
                          The service settles outstanding metered windows before closing this session. Read the final charges in your
                          activity log.
                        </p>
                      ),
                      run: async () => {
                        const res = await api.mutate(
                          'agents',
                          'session.close',
                          { sessionId: active.id },
                          sessionSchema.refine(
                            (row) => row.id === active.id && row.agentId === agent && row.status === 'closed',
                            'Session closure does not match the active session',
                          ),
                        );
                        if (res.ok && action.isCurrent()) setActive(res.data);
                        return res;
                      },
                      done: () => {
                        usage.reload();
                        sessionLog.reload();
                        log.reload();
                      },
                    })
                  }
                >
                  Review session closure
                </Button>
                <Read resource={sessionLog.resource} retry={sessionLog.reload} empty="No actions in this session">
                  {(rows) => <Activity rows={rows} />}
                </Read>
              </>
            ) : (
              <p className="muted">Review a registered agent and open its session to use allowed engine tasks.</p>
            )}
            {action.feedback}
          </Panel>
        </div>
      ) : tab === 'Activity' ? (
        <Panel title="Your agent action log">
          <Read resource={log.resource} retry={log.reload} empty="No agent actions have been recorded">
            {(rows) => (
              <>
                <Activity rows={rows} />
                <Limit count={rows.length} limit={limit} cap={500} onChange={setLimit} />
              </>
            )}
          </Read>
          <p className="muted">
            The log reports exact costs but does not include a fee asset on each row. Use a matching session usage record for asset
            identity.
          </p>
        </Panel>
      ) : tab === 'Coach' ? (
        <Panel title="Curriculum coach">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCoachQuery(coachAsk);
            }}
          >
            <Field label="Learning question" value={coachAsk} onChange={(e) => setCoachAsk(e.target.value)} maxLength={2000} />
            <Button type="submit" variant="secondary">
              Find grounded lessons
            </Button>
          </form>
          <Read resource={coach.resource} retry={coach.reload}>
            {(c) =>
              c.status === 'refuse' ? (
                <p role="status">The coach cannot ground this request: {c.reason}. No advice or position claim was generated.</p>
              ) : (
                <>
                  <p>{c.citedCount} curriculum citations · no investment advice</p>
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
        <Panel title="Product agent boundaries">
          <Details
            items={[
              [
                'Navigator and Support data sessions',
                'The runSession contracts require a caller-supplied tier matrix. No authoritative customer tier-law publication is mounted. A customer cannot declare their own entitlement matrix, so grounded tool runs remain unavailable.',
              ],
              [
                'Market Scanner',
                'Signal ranking also requires a sealed input law and tier matrix. Neither is published through a customer-owned read. No quotes, ranking recipe, or signal count is invented.',
              ],
              [
                'Merchant watcher',
                'A published threshold, minimum sample count, rail allowlist, and owned merchant metrics context are required. These are not available as a customer configuration contract.',
              ],
              [
                'Copy intelligence',
                'Leader fixtures must come from the live source with an allowlist. User-typed P&L is not an authoritative input. Copy grants and actual leader data are on Trade.',
              ],
              [
                'Portfolio planner',
                'The service portfolio port is unconnected. No holdings, target order legs or live rebalancing are manufactured.',
              ],
              [
                'Launch and risk drafts',
                'Draft assessment is not issuance, screening-list publication, or KYC approval. Those actions require their owned source contracts.',
              ],
            ]}
          />
          <a className="text-link" href="/trade/copy">
            Open Copy
          </a>
          <a className="text-link" href="/support">
            Open Support
          </a>
        </Panel>
      )}
      {action.dialog}
    </div>
  );
}
function Activity({ rows }: { rows: z.infer<typeof actionSchema>[] }) {
  return (
    <DataTable headers={['Time', 'Agent / session', 'Action', 'Outcome', 'Cost']} label="Agent audit activity">
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
          <td>{r.cost} · asset not supplied by log</td>
        </tr>
      ))}
    </DataTable>
  );
}
