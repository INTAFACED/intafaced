import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Dialog, Failure, Field, Panel, Tabs } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read, TextArea } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import {
  ownAgentCatalogueSchema as catalogueSchema,
  ownAgentLimitsSchema,
  ownAgentRunResultSchema,
  ownAgentRunRowSchema,
  ownAgentSchema,
  ownAgentSessionClosedSchema,
  ownAgentSessionSchema,
  ownAgentUsageDaySchema,
  ownAgentUsageWindowSchema,
  type OwnAgent,
  type OwnAgentCatalogue,
  type OwnAgentLimits,
  type OwnAgentRunResult,
} from '@intafaced/contracts/agents-own';

type ToolEntry = OwnAgentCatalogue['tools'][number];

const OWN_AGENT_PATH = /^\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** The id of the person's own agent an address names, or null. */
export const ownAgentId = (path: string): string | null => OWN_AGENT_PATH.exec(path)?.[1] ?? null;

/** Each refusal and finding code the service sends, with the words for it (the reserved name takes the name). */
const CODE_WORDS = {
  'agents.spend.per_call_above_session': 'code_spend_per_call_above_session',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.name_too_long': 'code_own_name_too_long',
  'agents.own.instructions_too_long': 'code_own_instructions_too_long',
  'agents.own.cap_invalid': 'code_own_cap_invalid',
  'agents.own.template_unknown': 'code_own_template_unknown',
  'agents.own.not_found': 'code_own_not_found',
  'agents.own.text_invalid': 'code_own_text_invalid',
  'agents.own.too_many': 'code_own_too_many',
  'agents.own.name_unset': 'code_own_name_unset',
  'agents.spend.cap_unset': 'code_spend_cap_unset',
  'agents.spend.cap_exceeded': 'code_spend_cap_exceeded',
  'agents.funds_insufficient': 'code_funds_insufficient',
  'agents.funds_unread': 'code_funds_unread',
  'agents.price_unset': 'code_price_unset',
  'agents.spend_limit': 'code_spend_limit',
  'agents.request_id_replay': 'code_request_id_replay',
  'agents.session_closed': 'code_session_closed',
  'agents.session_not_found': 'code_session_not_found',
  'agents.window_unpaid': 'code_window_unpaid',
  'agents.overage_grace_unset': 'code_overage_grace_unset',
  'agents.overage_grace_exceeded': 'code_overage_grace_exceeded',
  'agents.window_sealed': 'code_window_sealed',
} as const;
const wordsKey = (code: string) => (Object.hasOwn(CODE_WORDS, code) ? CODE_WORDS[code as keyof typeof CODE_WORDS] : null);

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/**
 * The service's own refusals arrive as an `agents.` code, whatever the status (a run's refusal is 403, a session of
 * someone else's is 404); anything else (a timeout, a gateway answer, a write that may have gone through) is not one.
 */
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** A refusal as words, with its code beside them so support can find it. */
function Refusal({
  code,
  name = '',
  cap = '',
  asset = '',
  inline = false,
}: {
  code: string;
  name?: string;
  cap?: string;
  asset?: string;
  /** In a table row: the words without announcing them, since the row is a record, not a fresh refusal. */
  inline?: boolean;
}) {
  const { t } = agentBuilderCopy.useCopy();
  const key = wordsKey(code);
  const words =
    code === 'agents.own.reserved_name'
      ? t('code_own_reserved_name', { name })
      : code === 'agents.spend.above_agent_cap'
        ? t('code_spend_above_agent_cap', { cap, asset })
        : key
          ? t(key)
          : t('code_other');
  return inline ? (
    <span>
      {words} <code lang="zxx">{code}</code>
    </span>
  ) : (
    <p role="alert">
      {words} <code lang="zxx">{code}</code>
    </p>
  );
}
/** What a failed write says: the service's refusal in words, or the app's own account of a write it could not confirm. */
function Answer({ failed, ...params }: { failed: Failed; name?: string; cap?: string; asset?: string }) {
  const code = refusalCode(failed);
  return code ? <Refusal code={code} {...params} /> : <Failure result={failed} />;
}
/** Tells the page title a draft was saved under a new name. */
const SAVED_EVENT = 'intafaced:own-agent-saved';

/** /agents/new: pick a template, which makes a draft, then build it. Nothing here moves money. */
export function NewAgent() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // This visit's key for each template: pressing again after an answer that never arrived returns the draft the first
  // press made, rather than a second one. Each visit to the picker is a new draft.
  const visit = useRef(`picker:${crypto.randomUUID()}`);
  async function start(template: string) {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate('agents', 'own.create', { template, createKey: `${visit.current}:${template}` }, ownAgentSchema);
    setBusy(false);
    if (res.ok) navigate(`/agents/${res.data.id}`, true);
    else setRefused(res);
  }
  return (
    <div className="more-grid">
      <Panel title={t('templatesTitle')} role="region" aria-label={t('templatesTitle')}>
        <p className="muted">{t('templatesIntro')}</p>
        <div className="depth-card-actions">
          <Button disabled={busy} onClick={() => void start('service-starter')}>
            {t('useServiceStarter')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void start('blank')}>
            {t('startBlank')}
          </Button>
        </div>
        {refused ? <Answer failed={refused} /> : null}
      </Panel>
      <Panel title={t('assistantTitle')} role="region" aria-label={t('assistantTitle')}>
        <p role="note">
          {t('assistantBlocked')} <code lang="zxx">owner.decision</code>
        </p>
        <Button disabled>{t('draftIt')}</Button>
      </Panel>
    </div>
  );
}

/** The builder form for one draft, and what blocks publishing it. */
export function Builder({ agent, onSaved }: { agent: OwnAgent; onSaved: (agent: OwnAgent) => void }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const catalogue = useResource((signal) => api.query('agents', 'own.catalogue', undefined, catalogueSchema, { signal }), 'own-catalogue');
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [cap, setCap] = useState(agent.perSessionCap ?? '');
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [picking, setPicking] = useState(false);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [moneyTool, setMoneyTool] = useState(false);
  const [saved, setSaved] = useState(false);
  const edited = () => setSaved(false);
  const [busy, setBusy] = useState(false);
  function add(tool: ToolEntry) {
    setPicking(false);
    setSaved(false);
    // The service refuses it on save too; saying so now spares a round trip.
    setMoneyTool(tool.movesMoney);
    if (tool.movesMoney) return;
    setRefused(null);
    edited();
    setTools((current) => (current.includes(tool.name) ? current : [...current, tool.name]));
  }
  async function save() {
    setBusy(true);
    setSaved(false);
    setRefused(null);
    setMoneyTool(false);
    const res = await api.mutate(
      'agents',
      'own.save',
      { id: agent.id, name, instructions, tools, perSessionCap: cap.trim() ? cap.trim() : null },
      ownAgentSchema.refine((row) => row.id === agent.id),
    );
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setSaved(true);
    onSaved(res.data);
    window.dispatchEvent(new CustomEvent(SAVED_EVENT, { detail: res.data }));
  }
  return (
    <>
      <Panel title={t('builderTitle')}>
        <form
          aria-label={t('builderTitle')}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="muted">
            {t('draftLabel')}{' '}
            <code data-testid="draft-id" lang="zxx">
              {agent.id}
            </code>
          </p>
          <Field
            label={t('name')}
            value={name}
            maxLength={64}
            onChange={(event) => {
              edited();
              setName(event.target.value);
            }}
          />
          <TextArea
            label={t('instructions')}
            value={instructions}
            maxLength={4000}
            onChange={(value) => {
              edited();
              setInstructions(value);
            }}
          />
          <Field
            label={t('cap')}
            hint={t('capHint')}
            inputMode="decimal"
            value={cap}
            onChange={(event) => {
              edited();
              setCap(event.target.value);
            }}
          />
          <h3>{t('toolsTitle')}</h3>
          {tools.length ? (
            <ul aria-label={t('toolsTitle')}>
              {tools.map((tool) => (
                <li key={tool}>
                  <code lang="zxx">{tool}</code>{' '}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      edited();
                      setTools((current) => current.filter((name) => name !== tool));
                    }}
                  >
                    {t('removeTool')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('noTools')}</p>
          )}
          <Button variant="secondary" onClick={() => setPicking(true)}>
            {t('addTool')}
          </Button>
          {moneyTool ? <Refusal code="agents.own.money_tool" /> : null}
          {refused ? <Answer failed={refused} name={name.trim()} /> : null}
          <Button type="submit" disabled={busy}>
            {t('saveDraft')}
          </Button>
          {saved ? <p role="status">{t('draftSaved')}</p> : null}
        </form>
        {picking ? (
          <Dialog title={t('addTool')} onClose={() => setPicking(false)}>
            <Read resource={catalogue.resource} retry={catalogue.reload}>
              {({ tools: offered }) => (
                <ul role="listbox" aria-label={t('addTool')}>
                  {offered.map((tool) => (
                    <li
                      key={tool.name}
                      role="option"
                      aria-selected={tools.includes(tool.name)}
                      tabIndex={0}
                      onClick={() => add(tool)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          add(tool);
                        }
                      }}
                    >
                      <code lang="zxx">{tool.name}</code> · {tool.movesMoney ? t('movesMoney') : t('readsModule', { module: tool.module })}
                    </li>
                  ))}
                </ul>
              )}
            </Read>
          </Dialog>
        ) : null}
      </Panel>
      <ProtectionCheck agent={agent} />
    </>
  );
}

/** What blocks publishing this draft, from the service's own check of what was last saved. */
function ProtectionCheck({ agent }: { agent: OwnAgent }) {
  const { t } = agentBuilderCopy.useCopy();
  return (
    <Panel title={t('checkTitle')} role="region" aria-label={t('checkTitle')}>
      {agent.findings.length ? (
        <ul>
          {agent.findings.map((finding) => (
            <li key={finding.code}>
              {finding.code === 'agents.spend.cap_unset'
                ? t('finding_cap')
                : finding.code === 'agents.own.name_unset'
                  ? t('finding_name')
                  : t('code_other')}{' '}
              · {finding.blocksPublishing ? t('blocksPublishing') : t('advisory')} <code lang="zxx">{finding.code}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('checkClear')}</p>
      )}
    </Panel>
  );
}

const PAGES = [
  'Build',
  'Limits',
  'Rules',
  'Permissions',
  'Test',
  'Runs',
  'Evaluations',
  'Usage',
  'Analytics',
  'Allowance',
  'Access',
  'Schedules',
  'Triggers',
  'Memory',
  'Privacy',
  'Identity',
  'Sharing',
] as const;

/** /agents/<id>: one of the person's own agents, on its pages. */
export function OwnAgentPage({ id }: { id: string }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [page, setPage] = useState<string>('Build');
  // The open session belongs to the agent's page, not to one tab of it: moving to Usage and back keeps it.
  const session = useState<string | null>(null);
  const loaded = useResource((signal) => api.query('agents', 'own.get', { id }, ownAgentSchema, { signal }), `own-agent:${id}`);
  const [latest, setLatest] = useState<OwnAgent | null>(null);
  return (
    <Read resource={loaded.resource} retry={loaded.reload}>
      {(fetched) => {
        const agent = latest?.id === fetched.id ? latest : fetched;
        return (
          <div className="more-grid">
            <Tabs
              items={PAGES}
              labels={Object.fromEntries(PAGES.map((item) => [item, t(`page_${item}`)]))}
              value={page}
              onChange={setPage}
              label={t('pagesLabel')}
            />
            <p className="muted" data-testid="agent-version">
              {t(agent.state === 'published' ? 'versionPublished' : 'versionDraft', { version: String(agent.version) })}
            </p>
            {page === 'Build' ? (
              <>
                <Builder key={agent.id} agent={agent} onSaved={setLatest} />
                <Panel title={t('publishTitle')}>
                  <Publish agent={agent} />
                </Panel>
              </>
            ) : page === 'Limits' ? (
              <>
                <Limits agent={agent} />
                <Sessions agent={agent} session={session} />
              </>
            ) : page === 'Test' ? (
              <Sessions agent={agent} session={session} twice />
            ) : page === 'Runs' ? (
              <Runs agent={agent} />
            ) : page === 'Usage' ? (
              <Usage agent={agent} />
            ) : (
              <Panel title={t(`page_${page as (typeof PAGES)[number]}`)}>
                <p role="note">{t(`parked_${page as Exclude<(typeof PAGES)[number], 'Build' | 'Limits' | 'Test' | 'Runs' | 'Usage'>}`)}</p>
              </Panel>
            )}
          </div>
        );
      }}
    </Read>
  );
}

/** The amount with its asset, as the service sent it: a decimal string, never re-rounded. */
const money = (amount: string, asset: string) => `${amount} ${asset}`;

/**
 * The Limits page: the person's cap per call, per session and per month for this agent (AG-spend-01). All three or
 * none; a blank stays blank and the agent opens no session. A value above the agent's own cap is refused, not lowered.
 */
function Limits({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.limits.get', { id: agent.id }, ownAgentLimitsSchema, { signal }),
    `own-limits:${agent.id}`,
  );
  return (
    <Read resource={loaded.resource} retry={loaded.reload}>
      {(view) => <LimitsForm agent={agent} view={view} />}
    </Read>
  );
}

function LimitsForm({ agent, view }: { agent: OwnAgent; view: OwnAgentLimits }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [current, setCurrent] = useState(view);
  const [perCall, setPerCall] = useState(view.limits?.perCall ?? '');
  const [perSession, setPerSession] = useState(view.limits?.perSession ?? '');
  const [perPeriod, setPerPeriod] = useState(view.limits?.perPeriod ?? '');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const blankAsNull = (value: string) => (value.trim() ? value.trim() : null);
  async function save() {
    setBusy(true);
    setSaved(false);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.limits.set',
      { id: agent.id, perCall: blankAsNull(perCall), perSession: blankAsNull(perSession), perPeriod: blankAsNull(perPeriod) },
      ownAgentLimitsSchema,
    );
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setCurrent(res.data);
    setSaved(true);
  }
  const edit = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    setSaved(false);
    set(event.target.value);
  };
  return (
    <Panel title={t('limitsTitle')}>
      <form
        aria-label={t('limitsTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="muted">{t('limitsIntro', { asset: current.assetId })}</p>
        <Field label={t('perCall')} inputMode="decimal" value={perCall} onChange={edit(setPerCall)} />
        <Field label={t('perSession')} inputMode="decimal" value={perSession} onChange={edit(setPerSession)} />
        <Field label={t('perMonth')} inputMode="decimal" value={perPeriod} onChange={edit(setPerPeriod)} />
        <p data-testid="agent-cap">
          {current.agentCap === null ? t('agentCapUnset') : t('agentCap', { cap: money(current.agentCap, current.assetId) })}
        </p>
        <p data-testid="effective-per-session">
          {current.effectivePerSession === null
            ? t('effectiveUnset')
            : t('effective', { amount: money(current.effectivePerSession, current.assetId) })}
        </p>
        <p data-testid="overage-grace">
          {current.overageGrace === null ? t('graceUnset') : t('grace', { amount: money(current.overageGrace, current.assetId) })}
        </p>
        <Button type="submit" disabled={busy}>
          {t('saveLimits')}
        </Button>
        {saved ? <p role="status">{t('limitsSaved')}</p> : null}
        {refused ? <Answer failed={refused} cap={current.agentCap ?? ''} asset={current.assetId} /> : null}
      </form>
    </Panel>
  );
}

/** One run's answer: the reply and what it cost. */
type Ran = OwnAgentRunResult;

/**
 * A session of the agent and its runs. Each run is held against the agent's caps and the person's balance before the
 * engine is called; a refused one shows why and costs 0. On the Test page, "Run twice at once" sends two runs together
 * so the caps can be seen to admit only what fits.
 */
function Sessions({
  agent,
  session: [sessionId, setSessionId],
  twice = false,
}: {
  agent: OwnAgent;
  session: [string | null, (id: string | null) => void];
  twice?: boolean;
}) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [closed, setClosed] = useState(false);
  const [ask, setAsk] = useState('');
  const [ran, setRan] = useState<Ran | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const [runsVersion, setRunsVersion] = useState(0);
  // Each press is its own request: a business key from this visit, the session and a count, so a retried request
  // (the same key) is one run and one charge, and a new press is a new run.
  const presses = useRef(0);
  const visit = useRef(`${Date.now().toString(36)}`);
  async function open(): Promise<string | null> {
    setRefused(null);
    setClosed(false);
    const res = await api.mutate('agents', 'own.session.open', { id: agent.id }, ownAgentSessionSchema);
    if (!res.ok) {
      setRefused(res);
      return null;
    }
    setSessionId(res.data.sessionId);
    return res.data.sessionId;
  }
  const runOnce = (session: string) => {
    presses.current += 1;
    return api.mutate(
      'agents',
      'own.run',
      { id: agent.id, sessionId: session, requestId: `own-run:${session}:${visit.current}:${presses.current}`, ask },
      ownAgentRunResultSchema,
    );
  };
  /** Closes the session once its usage is paid; a window the ledger refused for funds keeps it open, and says so. */
  async function close(session: string) {
    setBusy(true);
    setRan(null);
    setRefused(null);
    const res = await api.mutate('agents', 'own.session.close', { id: agent.id, sessionId: session }, ownAgentSessionClosedSchema);
    if (res.ok) {
      setSessionId(null);
      setClosed(true);
    } else setRefused(res);
    setBusy(false);
    setRunsVersion((v) => v + 1);
  }
  async function run(times: number) {
    setBusy(true);
    setRan(null);
    setRefused(null);
    setClosed(false);
    const session = sessionId ?? (await open());
    if (session) {
      const results = await Promise.all(Array.from({ length: times }, () => runOnce(session)));
      const admitted = results.find((res) => res.ok);
      const failed = results.find((res) => !res.ok);
      if (admitted?.ok) setRan(admitted.data);
      if (failed && !failed.ok) setRefused(failed);
    }
    setBusy(false);
    setRunsVersion((v) => v + 1);
  }
  return (
    <>
      <Panel title={t('sessionTitle')} role="region" aria-label={t('sessionTitle')}>
        {sessionId ? (
          <p>
            {t('sessionOpen')} <code lang="zxx">{sessionId}</code>
          </p>
        ) : (
          <p className="muted">{t('sessionNone')}</p>
        )}
        {closed ? <p role="status">{t('sessionClosed')}</p> : null}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setRan(null);
            await open();
            setBusy(false);
            setRunsVersion((v) => v + 1);
          }}
        >
          {t('openSession')}
        </Button>
        {sessionId ? (
          <Button variant="secondary" disabled={busy} onClick={() => void close(sessionId)}>
            {t('closeSession')}
          </Button>
        ) : null}
        <TextArea label={t('ask')} value={ask} onChange={setAsk} maxLength={4000} />
        <Button disabled={busy || !sessionId || !ask.trim()} onClick={() => void run(1)}>
          {t('run')}
        </Button>
        {twice ? (
          <Button variant="secondary" disabled={busy || !ask.trim()} onClick={() => void run(2)}>
            {t('runTwice')}
          </Button>
        ) : null}
        {ran ? (
          <div role="region" aria-label={t('replyTitle')}>
            <p>{ran.text}</p>
            <p>
              {t('replyCost')} <span data-testid="reply-cost">{money(ran.cost, ran.assetId)}</span>
            </p>
          </div>
        ) : null}
        {refused ? <Answer failed={refused} /> : null}
      </Panel>
      <Runs agent={agent} version={runsVersion} />
    </>
  );
}

/** Every run asked of this agent, newest first: admitted with its exact cost, or refused with its reason and 0. */
function Runs({ agent, version = 0 }: { agent: OwnAgent; version?: number }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const runs = useResource(
    (signal) => api.query('agents', 'own.runs', { id: agent.id, limit: 50 }, z.array(ownAgentRunRowSchema), { signal }),
    `own-runs:${agent.id}:${version}`,
  );
  return (
    <Panel title={t('runsTitle')} role="region" aria-label={t('runsTitle')}>
      <Read resource={runs.resource} retry={runs.reload}>
        {(rows) => (
          <>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('runWhen')}</th>
                  <th scope="col">{t('runResult')}</th>
                  <th scope="col">{t('runReason')}</th>
                  <th scope="col">{t('runCost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.sessionId}:${row.sequence}`}>
                    <td>{new Date(row.occurredAt).toLocaleString()}</td>
                    <td>{t(`run_${row.status}`)}</td>
                    <td>{row.refusalCode ? <Refusal code={row.refusalCode} inline /> : null}</td>
                    <td data-testid="run-cost">{money(row.cost, row.assetId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 ? <p className="muted">{t('runsEmpty')}</p> : null}
          </>
        )}
      </Read>
    </Panel>
  );
}

/**
 * The Usage page: each usage window of this agent's sessions, newest first. A window seals when its session closes and
 * is charged on its own key; one the ledger refused for funds shows as unpaid, with that key, until it is retried.
 */
function Usage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const windows = useResource(
    (signal) => api.query('agents', 'own.usage', { id: agent.id, limit: 50 }, z.array(ownAgentUsageWindowSchema), { signal }),
    `own-usage:${agent.id}`,
  );
  return (
    <>
      <Panel title={t('usageTitle')} role="region" aria-label={t('usageTitle')}>
        <Read resource={windows.resource} retry={windows.reload}>
          {(rows) => (
            <>
              {rows.some((row) => row.state === 'unpaid') ? <p role="alert">{t('usageUnpaid')}</p> : null}
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('usageOpened')}</th>
                    <th scope="col">{t('usageSession')}</th>
                    <th scope="col">{t('usageState')}</th>
                    <th scope="col">{t('usageAmount')}</th>
                    <th scope="col">{t('usageChargeKey')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.sessionId}:${row.windowId}`}>
                      <td>{new Date(row.openedAt).toLocaleString()}</td>
                      <td>
                        <code lang="zxx">{row.sessionId}</code>
                      </td>
                      <td>{t(`usage_${row.state}`)}</td>
                      {row.amount === null ? (
                        <td>{t('usageNotSealed')}</td>
                      ) : (
                        <td data-testid="window-cost">{money(row.amount, row.assetId)}</td>
                      )}
                      <td>
                        {row.chargeKey ? (
                          <code lang="zxx" data-testid="charge-key">
                            {row.chargeKey}
                          </code>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 ? <p className="muted">{t('usageEmpty')}</p> : null}
            </>
          )}
        </Read>
      </Panel>
      <UsageByDay />
    </>
  );
}

/**
 * Usage by agent, day and task: every agent the person built, each row the exact sum of that agent's sealed windows on
 * one UTC day, so an agent's rows add up to its sealed windows above.
 */
function UsageByDay() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const days = useResource(
    (signal) => api.query('agents', 'own.usageByDay', undefined, z.array(ownAgentUsageDaySchema), { signal }),
    'own-usage-by-day',
  );
  return (
    <Panel title={t('byDayTitle')} role="region" aria-label={t('byDayTitle')}>
      <p className="muted">{t('byDayNote')}</p>
      <Read resource={days.resource} retry={days.reload}>
        {(rows) => (
          <>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('byDayAgent')}</th>
                  <th scope="col">{t('byDayDay')}</th>
                  <th scope="col">{t('byDayTask')}</th>
                  <th scope="col">{t('byDayWindows')}</th>
                  <th scope="col">{t('byDayCost')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.agentId}:${row.day}:${row.task}:${row.assetId}`} data-agent-id={row.agentId}>
                    <td>{row.agentName || t('untitled')}</td>
                    <td>{row.day}</td>
                    <td>
                      <code lang="zxx">{row.task}</code>
                    </td>
                    <td>{row.windows}</td>
                    <td data-testid="usage-cost">{money(row.amount, row.assetId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 ? <p className="muted">{t('byDayEmpty')}</p> : null}
          </>
        )}
      </Read>
    </Panel>
  );
}

/** Publishing refuses while the protection check blocks it; the publish flow itself is a later slice and says so. */
function Publish({ agent }: { agent: OwnAgent }) {
  const { t } = agentBuilderCopy.useCopy();
  const [pressed, setPressed] = useState(false);
  const blocking = agent.findings.find((finding) => finding.blocksPublishing);
  return (
    <>
      <Button onClick={() => setPressed(true)}>{t('publish')}</Button>
      {pressed ? blocking ? <Refusal code={blocking.code} /> : <p role="note">{t('publishParked')}</p> : null}
    </>
  );
}

/** The page title of one of the person's own agents: its name, or that it has none, following each save. */
export function OwnAgentTitle({ id }: { id: string }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource((signal) => api.query('agents', 'own.get', { id }, ownAgentSchema, { signal }), `own-agent-title:${id}`);
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => {
    const onSaved = (event: Event) => {
      const agent = (event as CustomEvent<OwnAgent>).detail;
      if (agent.id === id) setRenamed(agent.name);
    };
    window.addEventListener(SAVED_EVENT, onSaved);
    return () => window.removeEventListener(SAVED_EVENT, onSaved);
  }, [id]);
  const name = renamed ?? (loaded.resource.status === 'ready' ? loaded.resource.data.name : null);
  if (name === null) return <>{t('ownAgent')}</>;
  return <>{name || t('untitled')}</>;
}

/** The person's own agents, listed in the Agents room with a way to make one. */
export function MadeAgents() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const mine = useResource((signal) => api.query('agents', 'own.list', { limit: 50 }, z.array(ownAgentSchema), { signal }), 'own-agents');
  return (
    <Panel title={t('madeTitle')}>
      <a className="button button--secondary" href="/agents/new">
        {t('newAgent')}
      </a>
      <Read resource={mine.resource} retry={mine.reload} empty={t('madeEmpty')}>
        {(rows) => (
          <ul className="agent-session-list">
            {rows.map((row) => (
              <li key={row.id}>
                <a className="text-link" href={`/agents/${row.id}`}>
                  {row.name || t('untitled')}
                </a>{' '}
                <small>{t(row.state === 'published' ? 'versionPublished' : 'versionDraft', { version: String(row.version) })}</small>
              </li>
            ))}
          </ul>
        )}
      </Read>
    </Panel>
  );
}
