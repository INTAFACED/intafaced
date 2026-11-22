import { useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Select } from '@intafaced/ui/lit';
import { DataTable, Dialog, Failure, Field, Panel, Read } from './agent-room/parts';
import { agentGuardrailsCopy, hasGuardrailWords } from './agent-guardrails-copy';
import {
  OWN_AGENT_RULE_CHOICES,
  ownAgentApprovalRequestSchema,
  ownAgentToolCallSchema,
  type OwnAgent,
  type OwnAgentApprovalRequest,
  type OwnAgentCatalogue,
  type OwnAgentConsent,
  type OwnAgentDataClass,
  type OwnAgentRule,
  type OwnAgentRuleChoice,
  type OwnAgentToolCall,
} from '@intafaced/contracts/agents-own';
import {
  AGENTS_OWN_CATALOGUE,
  AGENTS_OWN_SESSION_OPEN,
  AGENTS_OWN_RULES_LIST,
  AGENTS_OWN_RULES_SAVE,
  AGENTS_OWN_CONSENTS_LIST,
  AGENTS_OWN_CONSENTS_REVOKE,
  AGENTS_OWN_CONSENTS_GRANT,
} from '@intafaced/contracts/agents-own-procedures';

/**
 * An own agent's Rules and Permissions pages, and the tool test on its Test page (AG-guardrails-01, AG-guardrails-02).
 * Every answer comes from svc-agents: a rule saves or is refused at save with its code; a call of a kind of tool the
 * person has not allowed is refused until they allow it on the consent card; a call a rule asks about is an approval
 * request and the tool has not run. Nothing here moves money.
 */

export type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Words = ReturnType<typeof agentGuardrailsCopy.useCopy>['t'];
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
/** The service's own refusal code, or null for a timeout or anything else the app must word itself. */
const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

const CODES = [
  'agents.consent_required',
  'agents.consent_not_granted',
  'agents.rule_invalid',
  'agents.baseline_loosen_refused',
  'agents.baseline_value_unset',
  'agents.rule_hand_off',
  'agents.tool_not_wired',
  'agents.tool_not_declared',
  'agents.request_id_replay',
  'agents.own.not_found',
  'agents.spend.cap_unset',
  'agents.session_closed',
  'agents.approval.rejected',
  'agents.approval.expired',
  'agents.approval.replaced',
  'agents.approval.decided',
  'agents.approval.not_found',
  'agents.approval.ttl_unset',
  'agents.approval.input_invalid',
  'agents.approval.running',
  'agents.approval.failed',
  'agents.identity.owner_unread',
  'agents.identity.owner_frozen',
  'agents.identity.owner_inactive',
] as const;

/** A refusal as words with its code beside them, or the app's own account of a failure that is not one. */
export function Answer({ failed }: { failed: Failed }) {
  const { t } = agentGuardrailsCopy.useCopy();
  const refusal = refusalWords(t, failed);
  if (!refusal) return <Failure result={failed} />;
  return (
    <p role="alert">
      {refusal.words} <code lang="zxx">{refusal.code}</code>
    </p>
  );
}

/** A refusal's code and its words, as Answer says them; null for a failure that is not a refusal of svc-agents'. */
export function refusalWords(t: Words, failed: Failed): { code: string; words: string } | null {
  const code = refusalCode(failed);
  if (!code) return null;
  const key = `code_${code.replaceAll('.', '_')}`;
  const words = code.startsWith('agents.tool_refused.')
    ? t('code_tool_refused')
    : (CODES as readonly string[]).includes(code) && hasGuardrailWords(key)
      ? t(key)
      : t('code_other');
  return { code, words };
}

/** A request's state in words: an approved one says whether its tool has run yet. */
export function requestStateWords(t: Words, row: Pick<OwnAgentApprovalRequest, 'status' | 'ranAt'>): string {
  if (row.status === 'approved') return t(row.ranAt ? 'request_ran' : 'request_approved');
  return t(`request_${row.status}`);
}

const slug = (tool: string) => tool.replaceAll('.', '_');
/** A tool in words, or its name when the copy has none. */
export function toolWords(t: Words, tool: string): string {
  const key = `tool_${slug(tool)}`;
  return hasGuardrailWords(key) ? t(key) : tool;
}
function actionWords(t: Words, tool: string): string {
  const key = `action_${slug(tool)}`;
  return hasGuardrailWords(key) ? t(key) : tool;
}
const classWords = (t: Words, dataClass: OwnAgentDataClass) => t(`class_${dataClass}`);
const ruleWords = (t: Words, rule: Pick<OwnAgentRule, 'tool' | 'choice'>) =>
  t(`rule_${rule.choice}`, { action: actionWords(t, rule.tool) });

const requestsSchema = z.array(ownAgentApprovalRequestSchema);

/** The Rules page: the person's standing rules for this agent, one per tool. */
export function RulesPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const loaded = useResource((signal) => api.call(AGENTS_OWN_RULES_LIST, { id: agent.id }, { signal }), `own-rules:${agent.id}`);
  return (
    <Panel title={t('rulesTitle')}>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(rules) => <RulesForm agent={agent} stored={rules} />}
      </Read>
    </Panel>
  );
}

function RulesForm({ agent, stored }: { agent: OwnAgent; stored: OwnAgentRule[] }) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const [rules, setRules] = useState(stored);
  const [tool, setTool] = useState(agent.tools[0] ?? '');
  const [choice, setChoice] = useState<OwnAgentRuleChoice>('ask_before');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setSaved(false);
    setRefused(null);
    const res = await api.call(AGENTS_OWN_RULES_SAVE, { id: agent.id, tool, choice });
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setRules((current) => [...current.filter((rule) => rule.tool !== res.data.tool), res.data]);
    setSaved(true);
  }
  return (
    <form
      aria-label={t('rulesTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="lt-muted">{t('rulesIntro')}</p>
      {agent.tools.length ? (
        <>
          <Select
            label={t('ruleAction')}
            value={tool}
            onChange={(value) => {
              setSaved(false);
              setTool(value);
            }}
            options={agent.tools.map((name) => ({ value: name, label: toolWords(t, name) }))}
          />
          <Select
            label={t('ruleWhen')}
            value={choice}
            onChange={(value) => {
              setSaved(false);
              setChoice(value as OwnAgentRuleChoice);
            }}
            options={OWN_AGENT_RULE_CHOICES.map((value) => ({ value, label: t(`choice_${value}`) }))}
          />
          <Button tone="primary" type="submit" disabled={busy || !tool}>
            {t('saveRule')}
          </Button>
        </>
      ) : (
        <p className="lt-muted">{t('noTools')}</p>
      )}
      {saved ? <p role="status">{t('ruleSaved')}</p> : null}
      {refused ? <Answer failed={refused} /> : null}
      <h3>{t('yourRules')}</h3>
      {rules.length ? (
        <ul aria-label={t('yourRules')}>
          {rules.map((rule) => (
            <li key={rule.id}>{ruleWords(t, rule)}</li>
          ))}
        </ul>
      ) : (
        <p className="lt-muted">{t('noRules')}</p>
      )}
    </form>
  );
}

/** The kinds of tools an agent's tools touch, in catalogue order, from the service's own catalogue. */
function classesOf(agent: OwnAgent, catalogue: OwnAgentCatalogue): OwnAgentDataClass[] {
  const classes: OwnAgentDataClass[] = [];
  for (const tool of catalogue.tools) {
    if (agent.tools.includes(tool.name) && tool.dataClass && !classes.includes(tool.dataClass)) classes.push(tool.dataClass);
  }
  return classes;
}

/** The Permissions page: the acts-as-you statement and each kind of tool the agent uses, with its consent. */
export function PermissionsPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const catalogue = useResource((signal) => api.call(AGENTS_OWN_CATALOGUE, undefined, { signal }), 'own-catalogue');
  const consents = useResource((signal) => api.call(AGENTS_OWN_CONSENTS_LIST, { id: agent.id }, { signal }), `own-consents:${agent.id}`);
  return (
    <>
      <Panel title={t('permissionsTitle')}>
        <p data-testid="acts-as-you">{t('actsAsYou')}</p>
        <h3>{t('classesTitle')}</h3>
        <Read resource={catalogue.resource} retry={catalogue.reload}>
          {(offered) => (
            <Read resource={consents.resource} retry={consents.reload}>
              {(stored) => <Consents agent={agent} classes={classesOf(agent, offered)} stored={stored} />}
            </Read>
          )}
        </Read>
      </Panel>
      <Panel title={t('domainsTitle')}>
        <p className="lt-muted">{t('domainsNone')}</p>
      </Panel>
      <Panel title={t('modeTitle')}>
        <p role="note">{t('modeParked')}</p>
      </Panel>
    </>
  );
}

function Consents({ agent, classes, stored }: { agent: OwnAgent; classes: OwnAgentDataClass[]; stored: OwnAgentConsent[] }) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const [rows, setRows] = useState(stored);
  const [withdrawn, setWithdrawn] = useState<OwnAgentDataClass | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  async function revoke(dataClass: OwnAgentDataClass) {
    setBusy(true);
    setWithdrawn(null);
    setRefused(null);
    const res = await api.call(AGENTS_OWN_CONSENTS_REVOKE, { id: agent.id, dataClass });
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setRows((current) => [...current.filter((row) => row.dataClass !== dataClass), res.data]);
    setWithdrawn(dataClass);
  }
  if (!classes.length) return <p className="lt-muted">{t('classesEmpty')}</p>;
  return (
    <>
      <ul aria-label={t('classesTitle')}>
        {classes.map((dataClass) => {
          const row = rows.find((consent) => consent.dataClass === dataClass);
          return (
            <li key={dataClass}>
              {classWords(t, dataClass)} · {row ? t(`state_${row.state}`) : t('state_unasked')}
              {row?.state === 'granted' ? (
                <>
                  {' '}
                  <Button tone="secondary" disabled={busy} onClick={() => void revoke(dataClass)}>
                    {t('revoke')}
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {withdrawn ? <p role="status">{t('withdrawn', { class: classWords(t, withdrawn) })}</p> : null}
      {refused ? <Answer failed={refused} /> : null}
    </>
  );
}

/**
 * The tool test on the Test page: one call of one of the agent's tools in its session, through the same gates the agent's
 * calls pass. A kind of tool not yet allowed opens the consent card; a call a rule asks about lands in Approval requests.
 */
export function TryTool({
  agent,
  session: [sessionId, setSessionId],
}: {
  agent: OwnAgent;
  session: [string | null, (id: string | null) => void];
}) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const catalogue = useResource((signal) => api.call(AGENTS_OWN_CATALOGUE, undefined, { signal }), 'own-catalogue');
  const [tool, setTool] = useState(agent.tools[0] ?? '');
  const [args, setArgs] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<OwnAgentToolCall | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [consent, setConsent] = useState<{ dataClass: OwnAgentDataClass; failed: Failed } | null>(null);
  const [allowed, setAllowed] = useState<OwnAgentDataClass | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestsVersion, setRequestsVersion] = useState(0);
  // Each press is its own call: a business key from this visit, the session and a count, so a retried request is the
  // same call (one approval request at most) and a new press is a new one.
  const presses = useRef(0);
  const visit = useRef(Date.now().toString(36));

  async function sessionFor(): Promise<string | null> {
    if (sessionId) return sessionId;
    const res = await api.call(AGENTS_OWN_SESSION_OPEN, { id: agent.id });
    if (!res.ok) {
      setRefused(res);
      return null;
    }
    setSessionId(res.data.sessionId);
    return res.data.sessionId;
  }

  async function run(classOf: (name: string) => OwnAgentDataClass | null) {
    setBusy(true);
    setAnswer(null);
    setRefused(null);
    setAllowed(null);
    const session = await sessionFor();
    if (session) {
      presses.current += 1;
      const res = await api.mutate(
        'agents',
        'own.tool.try',
        { id: agent.id, sessionId: session, requestId: `own-try:${session}:${visit.current}:${presses.current}`, tool, input: args },
        ownAgentToolCallSchema,
      );
      if (res.ok) {
        setAnswer(res.data);
        if (res.data.outcome === 'waiting') setRequestsVersion((v) => v + 1);
      } else if (refusalCode(res) === 'agents.consent_required' && classOf(tool)) {
        setConsent({ dataClass: classOf(tool)!, failed: res });
      } else {
        if (refusalCode(res) === 'agents.session_closed') setSessionId(null);
        setRefused(res);
      }
    }
    setBusy(false);
  }

  async function allow(dataClass: OwnAgentDataClass) {
    setBusy(true);
    const res = await api.call(AGENTS_OWN_CONSENTS_GRANT, { id: agent.id, dataClass });
    setBusy(false);
    setConsent(null);
    if (!res.ok) return setRefused(res);
    setAllowed(dataClass);
  }

  return (
    <>
      <Panel title={t('tryTitle')} role="region" aria-label={t('tryTitle')}>
        <p className="lt-muted">{t('tryIntro')}</p>
        <Read resource={catalogue.resource} retry={catalogue.reload}>
          {(offered) => {
            const declared = offered.tools.find((entry) => entry.name === tool);
            const classOf = (name: string) => offered.tools.find((entry) => entry.name === name)?.dataClass ?? null;
            return (
              <>
                {agent.tools.length ? (
                  <Select
                    label={t('tryTool')}
                    value={tool}
                    onChange={(value) => {
                      setTool(value);
                      setArgs({});
                    }}
                    options={agent.tools.map((name) => ({ value: name, label: toolWords(t, name) }))}
                  />
                ) : (
                  <p className="lt-muted">{t('noTools')}</p>
                )}
                {Object.keys(declared?.shape?.input ?? {}).map((field) => (
                  <Field
                    key={`${tool}:${field}`}
                    label={field}
                    hint={declared?.shape?.input[field]}
                    value={args[field] ?? ''}
                    maxLength={4000}
                    onChange={(event) => setArgs((current) => ({ ...current, [field]: event.target.value }))}
                  />
                ))}
                <Button tone="primary" disabled={busy || !tool} onClick={() => void run(classOf)}>
                  {t('runTest')}
                </Button>
              </>
            );
          }}
        </Read>
        {allowed ? <p role="status">{t('allowed', { class: classWords(t, allowed) })}</p> : null}
        {answer?.outcome === 'waiting' ? <p role="status">{t('waiting', { action: actionWords(t, answer.tool) })}</p> : null}
        {answer?.outcome === 'ran' ? (
          <div role="region" aria-label={t('ranTitle')}>
            <p>{t('ran', { tool: toolWords(t, answer.tool) })}</p>
            <pre data-testid="tool-answer">{JSON.stringify(answer.result, null, 2)}</pre>
          </div>
        ) : null}
        {refused ? <Answer failed={refused} /> : null}
        {consent ? (
          <Dialog title={t('consentTitle', { class: classWords(t, consent.dataClass) })} onClose={() => setConsent(null)}>
            <Answer failed={consent.failed} />
            <p>{t('consentBody', { class: classWords(t, consent.dataClass) })}</p>
            <Button tone="primary" disabled={busy} onClick={() => void allow(consent.dataClass)}>
              {t('allow')}
            </Button>
            <Button tone="secondary" onClick={() => setConsent(null)}>
              {t('notNow')}
            </Button>
          </Dialog>
        ) : null}
      </Panel>
      <ApprovalRequests agent={agent} version={requestsVersion} />
    </>
  );
}

/** The calls of this agent a rule held for the person, newest first. None of them has run. */
function ApprovalRequests({ agent, version }: { agent: OwnAgent; version: number }) {
  const api = useApi();
  const { t } = agentGuardrailsCopy.useCopy();
  const requests = useResource(
    (signal) => api.query('agents', 'own.approvals', { id: agent.id, limit: 50 }, requestsSchema, { signal }),
    `own-approvals:${agent.id}:${version}`,
  );
  return (
    <Panel title={t('requestsTitle')}>
      <Read resource={requests.resource} retry={requests.reload}>
        {(rows) => (
          <>
            <DataTable label={t('requestsTitle')} headers={[t('requestWhen'), t('requestAction'), t('requestInput'), t('requestState')]}>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{toolWords(t, row.tool)}</td>
                  <td>
                    {Object.entries(row.input)
                      .map(([field, value]) => `${field}: ${value}`)
                      .join('; ')}
                  </td>
                  <td>{requestStateWords(t, row)}</td>
                </tr>
              ))}
            </DataTable>
            {rows.length === 0 ? <p className="lt-muted">{t('requestsEmpty')}</p> : null}
          </>
        )}
      </Read>
    </Panel>
  );
}
