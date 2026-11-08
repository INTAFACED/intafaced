import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Dialog, Failure, Field, Panel, Tabs } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read, TextArea } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import './agents-session.css';
import {
  ownAgentCatalogueSchema as catalogueSchema,
  ownAgentLimitsSchema,
  ownAgentPaymentMethodSchema,
  ownAgentRunResultSchema,
  ownAgentRunRowSchema,
  ownAgentSchema,
  ownAgentSessionClosedSchema,
  ownAgentSessionSchema,
  ownAgentUsageDaySchema,
  ownAgentUsageWindowSchema,
  ownAgentCoOwnerSchema,
  ownAgentDeletedSchema,
  ownAgentPublicationSchema,
  ownAgentSharedSchema,
  OWN_AGENT_DELETE_CONFIRMATION,
  type OwnAgent,
  type OwnAgentPublication,
  type OwnAgentCatalogue,
  type OwnAgentLimits,
  type OwnAgentPaymentMethod,
  type OwnAgentRunResult,
} from '@intafaced/contracts/agents-own';
import { ownAgentUsageLimitsSchema, type OwnAgentUsageLimits } from '@intafaced/contracts/agents-usage-limits';
import { ServiceOffNotice } from '../../shared/service-off';
import { PermissionsPage, RulesPage, toolWords, TryTool } from './AgentGuardrails';
import { ReviewerPanel } from './AgentReviewer';
import { agentGuardrailsCopy } from './agent-guardrails-copy';
import { EvaluationsPage } from './AgentEvaluations';
import { AnalyticsPage, RunsPage, TestPanel } from './AgentTestRuns';
import { AssistantPanel, IdentityPage } from './AgentIdentity';

type ToolEntry = OwnAgentCatalogue['tools'][number];

const OWN_AGENT_PATH = /^\/agents\/([^/]{1,64})$/;
/** The agent pages of their own under /agents/, which never name an agent. */
const AGENT_ROOMS = new Set(['new', 'team', 'approvals']);
/**
 * The id an address names under /agents/, or null. Any id opens the agent's page, so one that is not the person's,
 * or not an id at all, shows the service's own "not one of yours" refusal there, never a missing route.
 */
export const ownAgentId = (path: string): string | null => {
  const id = OWN_AGENT_PATH.exec(path)?.[1];
  return id && !AGENT_ROOMS.has(id) ? id : null;
};

/** Each refusal and finding code the service sends, with the words for it (the reserved name takes the name). */
const CODE_WORDS = {
  'agents.spend.per_call_above_session': 'code_spend_per_call_above_session',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.tool_shape_missing': 'code_tool_shape_missing',
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
  'agents.usage.hard_limit_reached': 'code_usage_hard_limit_reached',
  'agents.usage.limit_invalid': 'code_usage_limit_invalid',
  'agents.usage.alert_above_limit': 'code_usage_alert_above_limit',
  'agents.funds_insufficient': 'code_funds_insufficient',
  'agents.funds_unread': 'code_funds_unread',
  'agents.payment_method.wallet_not_linked': 'code_payment_method_wallet_not_linked',
  'agents.payment_method.account_inactive': 'code_payment_method_account_inactive',
  'agents.payment_method.wallets_unread': 'code_payment_method_wallets_unread',
  'agents.price_unset': 'code_price_unset_unread',
  'agents.spend_limit': 'code_spend_limit',
  'agents.request_id_replay': 'code_request_id_replay',
  'agents.session_closed': 'code_session_closed',
  'agents.session_not_found': 'code_session_not_found',
  'agents.window_unpaid': 'code_window_unpaid',
  'agents.overage_grace_unset': 'code_overage_grace_unset',
  'agents.overage_grace_exceeded': 'code_overage_grace_exceeded',
  'agents.window_sealed': 'code_window_sealed',
  'agents.own.surface_not_reviewed': 'code_own_surface_not_reviewed',
  'agents.own.surface_unknown': 'code_own_surface_unknown',
  'agents.own.co_owner_group': 'code_own_co_owner_group',
  'agents.own.co_owner_invalid': 'code_own_co_owner_invalid',
  'agents.own.co_owner_self': 'code_own_co_owner_self',
  'agents.own.co_owner_unread': 'code_own_co_owner_unread',
  'agents.own.co_owner_inactive': 'code_own_co_owner_inactive',
  'agents.own.delete_unconfirmed': 'code_own_delete_unconfirmed',
  'agents.own.delete_published': 'code_own_delete_published',
  'agents.own.delete_has_sessions': 'code_own_delete_has_sessions',
  'agents.agent.disabled': 'code_agent_disabled',
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

/** The words' parameters a refused run's row carries (`own.runs`): a funds refusal names its method, figure and source. */
type RefusalParams = Readonly<Record<string, string | number>>;
type BuilderT = ReturnType<typeof agentBuilderCopy.useCopy>['t'];
/** The test networks a TEST stack's chain stands in for: their figures are labelled TEST. */
const TEST_CHAIN_IDS: ReadonlySet<string> = new Set(['84532', '31337', '11155111']);
const FUNDS_WHY = {
  payment_token_unset: 'fundsWhy_payment_token_unset',
  wallet_unlinked: 'fundsWhy_wallet_unlinked',
  account_inactive: 'fundsWhy_account_inactive',
  identity_unreachable: 'fundsWhy_identity_unreachable',
  chain_unreachable: 'fundsWhy_chain_unreachable',
  chain_mismatch: 'fundsWhy_chain_mismatch',
  method_unread: 'fundsWhy_method_unread',
} as const;
const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);
const text = (params: RefusalParams, key: string) => (params[key] === undefined ? '' : String(params[key]));

/**
 * A funds refusal of a run paid from a wallet: the wallet, its figure with its source and as-of time, or why its amount
 * could not be read (J-agents-02 #4). Null when the refusal names no wallet, so today's words stand.
 */
function walletFundsWords(t: BuilderT, code: string, params: RefusalParams): string | null {
  if (params.method !== 'wallet' || typeof params.address !== 'string') return null;
  const address = shortAddress(params.address);
  if (code === 'agents.funds_insufficient') {
    const chainId = text(params, 'chainId');
    const block = text(params, 'block');
    const asOf = new Date(text(params, 'asOf'));
    return t('fundsWalletInsufficient', {
      address,
      available: text(params, 'available'),
      token: text(params, 'token'),
      asset: text(params, 'asset'),
      worstCase: text(params, 'worstCase'),
      source: t(TEST_CHAIN_IDS.has(chainId) ? 'fundsSourceTestChain' : 'fundsSourceChain', { chainId, block }),
      asOf: Number.isNaN(asOf.getTime()) ? text(params, 'asOf') : asOf.toLocaleString(),
    });
  }
  if (code === 'agents.funds_unread') {
    const reason = text(params, 'reason');
    const why = Object.hasOwn(FUNDS_WHY, reason) ? FUNDS_WHY[reason as keyof typeof FUNDS_WHY] : 'fundsWhy_method_unread';
    return t('fundsWalletUnread', { address, why: t(why) });
  }
  return null;
}

/** A refusal as words, with its code beside them so support can find it. */
export function Refusal({
  code,
  name = '',
  cap = '',
  asset = '',
  task = '',
  params = {},
  inline = false,
}: {
  code: string;
  name?: string;
  cap?: string;
  asset?: string;
  /** The routing task svc-agents logged the refused run under: a blank rate is named by it, never by the copy. */
  task?: string;
  /** The refused run's own parameters, as its row carries them: a wallet's figure and source, or why it was unread. */
  params?: RefusalParams;
  /** In a table row: the words without announcing them, since the row is a record, not a fresh refusal. */
  inline?: boolean;
}) {
  const { t } = agentBuilderCopy.useCopy();
  const key = wordsKey(code);
  const wallet = walletFundsWords(t, code, params);
  const words =
    wallet !== null
      ? wallet
      : code === 'agents.own.reserved_name'
        ? t('code_own_reserved_name', { name })
        : code === 'agents.spend.above_agent_cap'
          ? t('code_spend_above_agent_cap', { cap, asset })
          : code === 'agents.price_unset'
            ? task
              ? t('code_price_unset', { task })
              : t('code_price_unset_unread')
            : key
              ? t(key)
              : t('code_other');
  // A wallet is named short in the words and in full on the element, with its figure's block and time as the chain gave them.
  const named =
    wallet !== null
      ? {
          title: String(params.address),
          'data-wallet': String(params.address),
          ...(params.block === undefined ? {} : { 'data-block': String(params.block), 'data-as-of': String(params.asOf ?? '') }),
          ...(params.reason === undefined ? {} : { 'data-reason': String(params.reason) }),
        }
      : {};
  return inline ? (
    <span {...named}>
      {words} <code lang="zxx">{code}</code>
    </span>
  ) : (
    <p role="alert" {...named}>
      {words} <code lang="zxx">{code}</code>
    </p>
  );
}
/** What a failed write says: the service's refusal in words, or the app's own account of a write it could not confirm. */
function Answer({
  failed,
  ...params
}: {
  failed: Failed;
  name?: string;
  cap?: string;
  asset?: string;
  task?: string;
  params?: RefusalParams;
}) {
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
  // The templates the service offers (AG-catalogue-02): a template it does not offer has no button.
  const catalogue = useResource((signal) => api.query('agents', 'own.catalogue', undefined, catalogueSchema, { signal }), 'own-catalogue');
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
          {/* The starter shows once the service says it offers it; "Start blank" is always offered and needs no read. */}
          {catalogue.resource.status === 'ready' &&
          catalogue.resource.data.templates.some((template) => template.id === 'service-starter') ? (
            <Button disabled={busy} onClick={() => void start('service-starter')}>
              {t('useServiceStarter')}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={() => void start('blank')}>
            {t('startBlank')}
          </Button>
        </div>
        {catalogue.resource.status === 'failed' ? (
          <Read resource={catalogue.resource} retry={catalogue.reload}>
            {() => null}
          </Read>
        ) : null}
        {refused ? <Answer failed={refused} /> : null}
      </Panel>
      <AssistantPanel />
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
          {tools.length ? (
            // Each attached tool's declared shape and refusals, as the service's registry holds them (AG-tools-01).
            <section role="group" aria-label={t('toolShapesTitle')}>
              <h3>{t('toolShapesTitle')}</h3>
              <Read resource={catalogue.resource} retry={catalogue.reload}>
                {({ tools: offered }) => (
                  <>
                    {tools.map((name) => {
                      const declared = offered.find((tool) => tool.name === name);
                      return (
                        <article key={name} aria-label={name}>
                          <h4>
                            <code lang="zxx">{name}</code>
                          </h4>
                          {declared?.shape ? (
                            <dl>
                              <dt>{t('shapeInput')}</dt>
                              <dd data-testid="shape-input">{fieldsOf(declared.shape.input)}</dd>
                              <dt>{t('shapeOutput')}</dt>
                              <dd data-testid="shape-output">{fieldsOf(declared.shape.output)}</dd>
                              <dt>{t('shapeRefusals')}</dt>
                              <dd data-testid="shape-refusals">
                                {declared.refusals.map((code, at) => (
                                  <span key={code}>
                                    {at ? ', ' : null}
                                    <code lang="zxx">{code}</code>
                                  </span>
                                ))}
                              </dd>
                            </dl>
                          ) : (
                            <p className="muted">{t('shapeNotDeclared')}</p>
                          )}
                        </article>
                      );
                    })}
                  </>
                )}
              </Read>
            </section>
          ) : null}
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
                      {!tool.movesMoney && !tool.shape ? <> · {t('shapeNotDeclaredShort')}</> : null}
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

/** A declared shape's fields as one line: each field name with its type in words. */
function fieldsOf(fields: Readonly<Record<string, string>>): string {
  return Object.entries(fields)
    .map(([field, type]) => `${field}: ${type}`)
    .join('; ');
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
  const [usageRuns, setUsageRuns] = useState(0);
  const countRun = useCallback(() => setUsageRuns((n) => n + 1), []);
  const loaded = useResource((signal) => api.query('agents', 'own.get', { id }, ownAgentSchema, { signal }), `own-agent:${id}`);
  const [latest, setLatest] = useState<OwnAgent | null>(null);
  // An agent that is not the person's, or an address that names none, is the service's refusal, not a retry.
  if (loaded.resource.status === 'failed' && refusalCode(loaded.resource.failure) === 'agents.own.not_found')
    return (
      <Panel title={t('ownAgent')}>
        <Refusal code="agents.own.not_found" />
        <a className="text-link" href="/agents">
          {t('backToAgents')}
        </a>
      </Panel>
    );
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
            <AgentStatus id={agent.id} />
            <p className="muted" data-testid="agent-version">
              {t(agent.state === 'published' ? 'versionPublished' : 'versionDraft', { version: String(agent.version) })}
            </p>
            {page === 'Build' ? (
              <>
                <Builder key={agent.id} agent={agent} onSaved={setLatest} />
                <Panel title={t('publishTitle')}>
                  <Publish agent={agent} onPublished={setLatest} />
                </Panel>
              </>
            ) : page === 'Limits' ? (
              <>
                <Limits agent={agent} />
                <UsageLimits agent={agent} runs={usageRuns} />
                <PaymentMethod agent={agent} />
                <Sessions agent={agent} session={session} onRun={countRun} />
              </>
            ) : page === 'Test' ? (
              <>
                <TestPanel agent={agent} />
                <Sessions agent={agent} session={session} twice />
                <TryTool agent={agent} session={session} />
              </>
            ) : page === 'Rules' ? (
              <>
                <RulesPage agent={agent} />
                <ReviewerPanel agent={agent} />
              </>
            ) : page === 'Permissions' ? (
              <PermissionsPage agent={agent} />
            ) : page === 'Runs' ? (
              <RunsPage agent={agent} live={<Runs agent={agent} />} />
            ) : page === 'Analytics' ? (
              <AnalyticsPage agent={agent} />
            ) : page === 'Usage' ? (
              <Usage agent={agent} />
            ) : page === 'Evaluations' ? (
              <EvaluationsPage agent={agent} />
            ) : page === 'Sharing' ? (
              <SharingPage agent={agent} />
            ) : page === 'Identity' ? (
              <IdentityPage key={agent.id} agent={agent} />
            ) : (
              <Panel title={t(`page_${page as (typeof PAGES)[number]}`)}>
                <p role="note">
                  {t(
                    `parked_${page as Exclude<(typeof PAGES)[number], 'Build' | 'Limits' | 'Test' | 'Runs' | 'Usage' | 'Rules' | 'Permissions' | 'Evaluations' | 'Analytics' | 'Sharing' | 'Identity'>}`,
                  )}
                </p>
              </Panel>
            )}
          </div>
        );
      }}
    </Read>
  );
}

const backgroundRunSchema = z.object({
  id: z.string(),
  state: z.enum(['running', 'done', 'stopped']),
  stepsDone: z.number(),
  stepsTotal: z.number(),
  stopCode: z.string().nullable(),
  cost: z.string(),
  startedAt: z.string(),
});

const agentStatusSchema = z.object({ status: z.enum(['active', 'quarantined', 'disabled_by_kind']) });

/**
 * Whether the agent may start new work (AG-control-02). Switched off by an operator, the page says so on every tab, with
 * the service's refusal code and the open button off; only an operator switches it off and only two founders restore it.
 */
function AgentStatus({ id }: { id: string }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource((signal) => api.query('agents', 'own.status', { id }, agentStatusSchema, { signal }), `own-status:${id}`);
  if (loaded.resource.status !== 'ready') return null;
  const off = loaded.resource.data.status !== 'active';
  return (
    <section aria-label={t('agentStatusTitle')}>
      <p data-testid="agent-status">{t(off ? 'status_disabled' : 'status_active')}</p>
      {off ? (
        <>
          <p className="muted">{t('disabledNote')}</p>
          <Refusal code="agents.agent.disabled" />
          <Button disabled>{t('openSession')}</Button>
        </>
      ) : null}
    </section>
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

/**
 * The alert and the hard limit for the month (J-agents-02 #6). Blank is not set. The alert is recorded once a month
 * when this agent's spend reaches it, and runs go on; at the hard limit a new run is refused and a run already started
 * finishes. Email is the person's choice, shown with the channel's real state: no email provider is connected.
 */
function UsageLimits({ agent, runs }: { agent: OwnAgent; runs: number }) {
  const api = useApi();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.usageLimits.get', { id: agent.id }, ownAgentUsageLimitsSchema, { signal }),
    `own-usage-limits:${agent.id}`,
  );
  return (
    <Read resource={loaded.resource} retry={loaded.reload}>
      {(view) => <UsageLimitsForm agent={agent} view={view} runs={runs} />}
    </Read>
  );
}

function UsageLimitsForm({ agent, view, runs }: { agent: OwnAgent; view: OwnAgentUsageLimits; runs: number }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [current, setCurrent] = useState(view);
  // A run on this page moves the month's spend: read it again after each one. The fresh read replaces what the form
  // shows as spent and reached, never what the person is typing.
  useEffect(() => {
    if (runs === 0) return;
    const controller = new AbortController();
    void api
      .query('agents', 'own.usageLimits.get', { id: agent.id }, ownAgentUsageLimitsSchema, { signal: controller.signal })
      .then((res) => {
        if (res.ok && !controller.signal.aborted) setCurrent(res.data);
      });
    return () => controller.abort();
  }, [runs, api, agent.id]);
  const [alertAt, setAlertAt] = useState(view.alertAt ?? '');
  const [hardLimit, setHardLimit] = useState(view.hardLimit ?? '');
  const [email, setEmail] = useState(view.email);
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
      'own.usageLimits.set',
      { id: agent.id, alertAt: blankAsNull(alertAt), hardLimit: blankAsNull(hardLimit), email },
      ownAgentUsageLimitsSchema,
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
    <Panel title={t('usageLimitsTitle')}>
      <form
        aria-label={t('usageLimitsTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="muted">{t('usageLimitsIntro', { asset: current.assetId })}</p>
        <Field label={t('alertAt')} inputMode="decimal" value={alertAt} onChange={edit(setAlertAt)} />
        <Field label={t('hardLimit')} inputMode="decimal" value={hardLimit} onChange={edit(setHardLimit)} />
        <Field
          label={t('alertByEmail')}
          type="checkbox"
          checked={email}
          onChange={(event) => {
            setSaved(false);
            setEmail(event.target.checked);
          }}
        />
        {email ? <ServiceOffNotice code="vendor.email" action={t('alertEmailAction')} role="note" /> : null}
        <p data-testid="usage-spent">{t('usageSpent', { month: current.month, amount: money(current.spent, current.assetId) })}</p>
        <p data-testid="usage-alert-state">
          {current.alert ? t('alertCrossed', { amount: money(current.alert.spent, current.assetId) }) : t('alertNotCrossed')}
        </p>
        <p data-testid="usage-hard-limit-state">
          {current.hardLimitReached
            ? t('hardLimitReached')
            : current.hardLimitRoom !== null
              ? t('hardLimitRoom', { amount: money(current.hardLimitRoom, current.assetId) })
              : t('hardLimitNotReached')}
        </p>
        <Button type="submit" disabled={busy}>
          {t('saveUsageLimits')}
        </Button>
        {saved ? <p role="status">{t('usageLimitsSaved')}</p> : null}
        {refused ? <Answer failed={refused} asset={current.assetId} /> : null}
      </form>
    </Panel>
  );
}

/**
 * The payment method of this agent's runs (J-agents-02 #4): one of the wallets the person linked by their own signature,
 * or none (the available balance). svc-agents lists the linked wallets through its own door to identity; with none
 * linked the page says so and links to where wallets are linked.
 */
export function PaymentMethod({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.paymentMethod.get', { id: agent.id }, ownAgentPaymentMethodSchema, { signal }),
    `own-payment-method:${agent.id}`,
  );
  return (
    <Read resource={loaded.resource} retry={loaded.reload}>
      {(view) => <PaymentMethodForm agent={agent} view={view} />}
    </Read>
  );
}

function PaymentMethodForm({ agent, view }: { agent: OwnAgent; view: OwnAgentPaymentMethod }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [current, setCurrent] = useState(view);
  const [choice, setChoice] = useState(view.method?.address ?? '');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const pickId = `payment-method-${agent.id}`;
  async function save() {
    setBusy(true);
    setSaved(false);
    setRefused(null);
    const res = await api.mutate('agents', 'own.paymentMethod.set', { id: agent.id, address: choice || null }, ownAgentPaymentMethodSchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setCurrent(res.data);
    setChoice(res.data.method?.address ?? '');
    setSaved(true);
  }
  const wallets = current.linked.state === 'usable' ? current.linked.wallets : [];
  return (
    <Panel title={t('paymentTitle')}>
      <form
        aria-label={t('paymentTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="muted">{t('paymentIntro')}</p>
        <p data-testid="payment-method">
          {current.method === null ? (
            t('paymentNone')
          ) : (
            <span title={current.method.address} data-wallet={current.method.address}>
              {t('paymentWallet', { address: shortAddress(current.method.address) })}
            </span>
          )}
        </p>
        {current.linked.state === 'unread' ? (
          <p role="status">{t('paymentWalletsUnread')}</p>
        ) : current.linked.state === 'account_inactive' ? (
          <p role="status">{t('paymentAccountInactive')}</p>
        ) : wallets.length === 0 ? (
          <p data-testid="payment-no-wallet">
            {t('paymentNoWallet')}{' '}
            <a className="text-link" href="/uc/safe">
              {t('paymentLinkWallets')}
            </a>
          </p>
        ) : (
          <>
            <label className="field" htmlFor={pickId}>
              <span>{t('paymentPick')}</span>
              <select
                id={pickId}
                value={choice}
                onChange={(event) => {
                  setSaved(false);
                  setChoice(event.target.value);
                }}
              >
                <option value="">{t('paymentPickNone')}</option>
                {wallets.map((wallet) => (
                  <option key={wallet.address} value={wallet.address}>
                    {wallet.address}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy}>
              {t('paymentSave')}
            </Button>
          </>
        )}
        {saved ? <p role="status">{t('paymentSaved')}</p> : null}
        {refused ? <Answer failed={refused} /> : null}
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
  onRun,
}: {
  agent: OwnAgent;
  session: [string | null, (id: string | null) => void];
  twice?: boolean;
  /** Told after each run or refusal, so a panel beside it can read the month's spend again. */
  onRun?: () => void;
}) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [closed, setClosed] = useState(false);
  const [ask, setAsk] = useState('');
  const [ran, setRan] = useState<Ran | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [refusedTask, setRefusedTask] = useState('');
  const [refusedParams, setRefusedParams] = useState<RefusalParams>({});
  const [busy, setBusy] = useState(false);
  const [runsVersion, setRunsVersion] = useState(0);
  useEffect(() => {
    if (runsVersion > 0) onRun?.();
  }, [runsVersion, onRun]);
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
  /** This session's newest run refused with `code`, as svc-agents logged it, or null when it cannot be read. */
  async function refusedRow(session: string, code: string) {
    const res = await api.query('agents', 'own.runs', { id: agent.id, limit: 10 }, z.array(ownAgentRunRowSchema));
    if (!res.ok) return null;
    return res.data.find((row) => row.sessionId === session && row.refusalCode === code) ?? null;
  }
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
      if (failed && !failed.ok) {
        // A blank rate is named by the task it was logged under; a funds refusal by its method, figure and source.
        const code = refusalCode(failed);
        const row =
          code === 'agents.price_unset' || code === 'agents.funds_insufficient' || code === 'agents.funds_unread'
            ? await refusedRow(session, code)
            : null;
        setRefusedTask(code === 'agents.price_unset' ? (row?.task ?? '') : '');
        setRefusedParams(row?.messageParams ?? {});
        setRefused(failed);
      }
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
        {refused ? <Answer failed={refused} task={refusedTask} params={refusedParams} /> : null}
      </Panel>
      <Runs agent={agent} version={runsVersion} />
    </>
  );
}

/**
 * Every run asked of this agent, newest first: admitted with its exact cost, refused with its reason and 0, or a tool call
 * a rule holds for the person, waiting for approval, which has not run and cost 0 (AG-approvals-01).
 */
function Runs({ agent, version = 0 }: { agent: OwnAgent; version?: number }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const runs = useResource(
    (signal) => api.query('agents', 'own.runs', { id: agent.id, limit: 50 }, z.array(ownAgentRunRowSchema), { signal }),
    `own-runs:${agent.id}:${version}`,
  );
  // Background test runs first, newest first: each says how far it got, or what stopped it at its next step.
  const background = useResource(
    (signal) => api.query('agents', 'own.backgroundRuns', { id: agent.id, limit: 20 }, z.array(backgroundRunSchema), { signal }),
    `own-background-runs:${agent.id}:${version}`,
  );
  const backgroundRows = background.resource.status === 'ready' ? background.resource.data : [];
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
                {backgroundRows.map((run) => (
                  <tr key={`background:${run.id}`} data-background-run={run.id}>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>
                      {run.state === 'running'
                        ? t('bg_running', { done: String(run.stepsDone), total: String(run.stepsTotal) })
                        : run.state === 'done'
                          ? t('bg_done', { total: String(run.stepsTotal) })
                          : run.stopCode === 'agents.agent.quarantined'
                            ? t('bg_stopped_quarantined')
                            : run.stopCode === 'agents.agent.disabled_by_kind'
                              ? t('bg_stopped_kind')
                              : t('bg_stopped_other')}
                    </td>
                    <td>{run.stopCode ? <code lang="zxx">{run.stopCode}</code> : null}</td>
                    <td data-testid="run-cost">{run.cost}</td>
                  </tr>
                ))}
                {rows.map((row) => (
                  <tr key={row.status === 'waiting' ? row.requestId : `${row.sessionId}:${row.sequence}`}>
                    <td>{new Date(row.occurredAt).toLocaleString()}</td>
                    <td>{t(`run_${row.status}`)}</td>
                    <td>
                      {row.status === 'waiting' ? (
                        t('runHeld', { tool: toolWords(tools, row.tool) })
                      ) : row.refusalCode ? (
                        <Refusal code={row.refusalCode} task={row.task ?? ''} params={row.messageParams} inline />
                      ) : null}
                    </td>
                    <td data-testid="run-cost">{money(row.cost, row.assetId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && backgroundRows.length === 0 ? <p className="muted">{t('runsEmpty')}</p> : null}
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
/**
 * Publishing (AG-builder-03; J-agents-03 #7): a finding that blocks publishing refuses at once with its code. Otherwise
 * the person chooses surfaces; one the policy forbids is offered but disabled, with its reason. Only the chosen
 * surfaces move to this version; the rest keep theirs, and a published version never changes.
 */
function Publish({ agent, onPublished }: { agent: OwnAgent; onPublished: (agent: OwnAgent) => void }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [blocked, setBlocked] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [published, setPublished] = useState<OwnAgentPublication | null>(null);
  const loaded = useResource(
    (signal) => api.query('agents', 'own.publication', { id: agent.id }, ownAgentPublicationSchema, { signal }),
    `own-publication:${agent.id}:${agent.version}:${agent.state}`,
  );
  const blocking = agent.findings.find((finding) => finding.blocksPublishing);
  const current =
    published && published.version === agent.version && published.state === agent.state
      ? published
      : loaded.resource.status === 'ready'
        ? loaded.resource.data
        : null;
  return (
    <>
      <Button
        onClick={() => {
          setBlocked(Boolean(blocking));
          setChoosing(!blocking);
        }}
      >
        {t('publish')}
      </Button>
      {blocked && blocking ? <Refusal code={blocking.code} /> : null}
      {published && published.version === agent.version && agent.state === 'published' ? (
        <p role="status">{t('publishedStatus', { version: String(agent.version) })}</p>
      ) : null}
      {choosing ? (
        <PublishDialog
          agent={agent}
          onClose={() => setChoosing(false)}
          onPublished={(publication) => {
            setChoosing(false);
            setPublished(publication);
            onPublished({ ...agent, version: publication.version, state: publication.state });
          }}
        />
      ) : null}
      {current ? (
        <PublicationView publication={current} />
      ) : (
        <Read resource={loaded.resource} retry={loaded.reload}>
          {(publication) => <PublicationView publication={publication} />}
        </Read>
      )}
    </>
  );
}

function PublishDialog({
  agent,
  onClose,
  onPublished,
}: {
  agent: OwnAgent;
  onClose: () => void;
  onPublished: (publication: OwnAgentPublication) => void;
}) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.publication', { id: agent.id }, ownAgentPublicationSchema, { signal }),
    `own-publication-choose:${agent.id}:${agent.version}:${agent.state}`,
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  async function publish() {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.publish',
      { id: agent.id, surfaces: chosen },
      ownAgentPublicationSchema.refine((row) => row.id === agent.id),
    );
    setBusy(false);
    if (res.ok) onPublished(res.data);
    else setRefused(res);
  }
  return (
    <Dialog title={t('publishTitle')} onClose={onClose}>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(publication) => (
          <fieldset>
            <legend>{t('publishChoose')}</legend>
            {publication.surfaces.map((surface) => (
              <div key={surface.surface}>
                <label className="agent-surface-choice">
                  <input
                    type="checkbox"
                    disabled={!surface.allowed || busy}
                    checked={chosen.includes(surface.surface)}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setChosen((current) =>
                        on
                          ? [...current.filter((name) => name !== surface.surface), surface.surface]
                          : current.filter((name) => name !== surface.surface),
                      );
                    }}
                  />{' '}
                  {t(`surface_${surface.surface}`)}
                </label>{' '}
                <small className="muted">
                  {surface.version === null ? t('surfaceNone') : t('surfaceCarries', { version: String(surface.version) })}
                </small>
                {!surface.allowed && surface.forbiddenCode ? (
                  <p className="muted">
                    {t('surfaceForbidden', { reason: surfaceReason(t, surface.forbiddenCode) })}{' '}
                    <code lang="zxx">{surface.forbiddenCode}</code>
                  </p>
                ) : null}
              </div>
            ))}
          </fieldset>
        )}
      </Read>
      {refused ? <Answer failed={refused} /> : null}
      <Button disabled={busy || chosen.length === 0} onClick={() => void publish()}>
        {t('publishVersion', { version: String(agent.version) })}
      </Button>
    </Dialog>
  );
}

/** The words for a surface the policy forbids, from the same catalogue as every refusal. */
function surfaceReason(t: ReturnType<typeof agentBuilderCopy.useCopy>['t'], code: string): string {
  const key = wordsKey(code);
  return key ? t(key) : t('code_other');
}

/** What is published where, as svc-agents holds it: each surface's version, every published version, open sessions. */
function PublicationView({ publication }: { publication: OwnAgentPublication }) {
  const { t } = agentBuilderCopy.useCopy();
  return (
    <>
      <section role="region" aria-label={t('surfacesTitle')}>
        <h3>{t('surfacesTitle')}</h3>
        <ul aria-label={t('surfacesTitle')}>
          {publication.surfaces.map((surface) => (
            <li key={surface.surface} data-surface={surface.surface}>
              {t(`surface_${surface.surface}`)} ·{' '}
              {surface.version === null ? t('surfaceNone') : t('surfaceCarries', { version: String(surface.version) })}
            </li>
          ))}
        </ul>
      </section>
      <section role="region" aria-label={t('versionsTitle')}>
        <h3>{t('versionsTitle')}</h3>
        <p className="muted">{t('versionsNote')}</p>
        {publication.versions.length ? (
          <ul aria-label={t('versionsTitle')}>
            {publication.versions.map((version) => (
              <li key={version.version}>
                <strong>{t('surfaceCarries', { version: String(version.version) })}</strong> ·{' '}
                <time dateTime={version.publishedAt}>{version.publishedAt}</time> ·{' '}
                <q data-testid="version-instructions">{version.instructions}</q>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('versionsEmpty')}</p>
        )}
      </section>
      <section role="region" aria-label={t('openSessionsTitle')}>
        <h3>{t('openSessionsTitle')}</h3>
        <p className="muted">{t('openSessionsNote')}</p>
        {publication.openSessions.length ? (
          <ul aria-label={t('openSessionsTitle')}>
            {publication.openSessions.map((session) => (
              <li key={session.sessionId}>
                <code lang="zxx">{session.sessionId}</code> · {t('openSessionVersion', { version: String(session.version) })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('openSessionsEmpty')}</p>
        )}
      </section>
    </>
  );
}

/**
 * The Sharing page (AG-builder-03; J-agents-03 #8): the agent's co-owners, each one person by account id. A group is
 * refused by svc-agents with its code, and nothing is added.
 */
function SharingPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.coOwners.list', { id: agent.id }, z.array(ownAgentCoOwnerSchema), { signal }),
    `own-co-owners:${agent.id}`,
  );
  const [rows, setRows] = useState<z.infer<typeof ownAgentCoOwnerSchema>[] | null>(null);
  const [coOwner, setCoOwner] = useState('');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  async function change(procedure: 'own.coOwners.add' | 'own.coOwners.remove', who: string) {
    setBusy(true);
    setRefused(null);
    setAdded(false);
    const res = await api.mutate('agents', procedure, { id: agent.id, coOwner: who }, z.array(ownAgentCoOwnerSchema));
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setRows(res.data);
    if (procedure === 'own.coOwners.add') {
      setAdded(true);
      setCoOwner('');
    }
  }
  const list = (owners: z.infer<typeof ownAgentCoOwnerSchema>[]) =>
    owners.length ? (
      <ul aria-label={t('coOwnersList')}>
        {owners.map((owner) => (
          <li key={owner.userId}>
            <code lang="zxx">{owner.userId}</code>{' '}
            <Button variant="ghost" disabled={busy} onClick={() => void change('own.coOwners.remove', owner.userId)}>
              {t('removeCoOwner')}
            </Button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{t('coOwnersEmpty')}</p>
    );
  return (
    <Panel title={t('coOwnersTitle')}>
      <form
        aria-label={t('coOwnersTitle')}
        onSubmit={(event) => {
          event.preventDefault();
          void change('own.coOwners.add', coOwner);
        }}
      >
        <p className="muted">{t('coOwnersIntro')}</p>
        <Field
          label={t('addCoOwner')}
          hint={t('addCoOwnerHint')}
          value={coOwner}
          maxLength={200}
          onChange={(event) => {
            setAdded(false);
            setCoOwner(event.target.value);
          }}
        />
        <Button type="submit" disabled={busy || !coOwner.trim()}>
          {t('addCoOwnerButton')}
        </Button>
        {refused ? <Answer failed={refused} /> : null}
        {added ? <p role="status">{t('coOwnerAdded')}</p> : null}
        {rows ? (
          list(rows)
        ) : (
          <Read resource={loaded.resource} retry={loaded.reload}>
            {(owners) => list(owners)}
          </Read>
        )}
      </form>
    </Panel>
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

/**
 * The person's own agents, listed in the Agents room with a way to make one. A draft can be deleted for good, only
 * after an irreversible confirmation (J-agents-03 #8). Agents others share with the person are listed apart.
 */
export function MadeAgents() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [reads, setReads] = useState(0);
  const mine = useResource(
    (signal) => api.query('agents', 'own.list', { limit: 50 }, z.array(ownAgentSchema), { signal }),
    `own-agents:${reads}`,
  );
  const shared = useResource(
    (signal) => api.query('agents', 'own.sharedWithMe', { limit: 50 }, z.array(ownAgentSharedSchema), { signal }),
    'own-agents-shared',
  );
  const [deleting, setDeleting] = useState<OwnAgent | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove(agent: OwnAgent) {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.delete',
      { id: agent.id, confirm: OWN_AGENT_DELETE_CONFIRMATION },
      ownAgentDeletedSchema.refine((row) => row.id === agent.id),
    );
    setBusy(false);
    setDeleting(null);
    if (!res.ok) return setRefused(res);
    setDeleted(true);
    setReads((n) => n + 1);
  }
  return (
    <>
      <Panel title={t('madeTitle')}>
        <a className="button button--secondary" href="/agents/new">
          {t('newAgent')}
        </a>
        <Read resource={mine.resource} retry={mine.reload} empty={t('madeEmpty')}>
          {(rows) => (
            <DataTable label={t('madeTitle')} headers={[t('madeName'), t('madeVersion'), t('madeActions')]}>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <a className="text-link" href={`/agents/${row.id}`}>
                      {row.name || t('untitled')}
                    </a>
                  </td>
                  <td>{t(row.state === 'published' ? 'versionPublished' : 'versionDraft', { version: String(row.version) })}</td>
                  <td>
                    {/* Only a draft never published can be deleted; one with a published version is kept. */}
                    {row.state === 'draft' && row.version === 1 ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRefused(null);
                          setDeleted(false);
                          setDeleting(row);
                        }}
                      >
                        {t('deleteDraft')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Read>
        {deleting ? (
          <div role="alertdialog" aria-label={t('deleteTitle')} className="depth-memory">
            <strong>{t('deleteTitle')}</strong>
            <p>{t('deleteBody', { name: deleting.name || t('untitled') })}</p>
            <div className="depth-card-actions">
              <Button disabled={busy} onClick={() => void remove(deleting)}>
                {t('deleteConfirm')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
                {t('deleteCancel')}
              </Button>
            </div>
          </div>
        ) : null}
        {refused ? <Answer failed={refused} /> : null}
        {deleted ? <p role="status">{t('deleted')}</p> : null}
      </Panel>
      <Panel title={t('sharedTitle')} role="region" aria-label={t('sharedTitle')}>
        <Read resource={shared.resource} retry={shared.reload} empty={t('sharedEmpty')}>
          {(rows) => (
            <DataTable label={t('sharedTitle')} headers={[t('madeName'), t('madeVersion'), t('sharedOwner')]}>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name || t('untitled')}</td>
                  <td>{t(row.state === 'published' ? 'versionPublished' : 'versionDraft', { version: String(row.version) })}</td>
                  <td>
                    <code lang="zxx">{row.ownerId}</code>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Read>
      </Panel>
    </>
  );
}
