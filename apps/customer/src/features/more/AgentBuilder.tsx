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
  ownAgentSchema,
  type OwnAgent,
  type OwnAgentCatalogue,
} from '@intafaced/contracts/agents-own';

type ToolEntry = OwnAgentCatalogue['tools'][number];

const OWN_AGENT_PATH = /^\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** The id of the person's own agent an address names, or null. */
export const ownAgentId = (path: string): string | null => OWN_AGENT_PATH.exec(path)?.[1] ?? null;

/** Each refusal and finding code the service sends, with the words for it (the reserved name takes the name). */
const CODE_WORDS = {
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.name_too_long': 'code_own_name_too_long',
  'agents.own.instructions_too_long': 'code_own_instructions_too_long',
  'agents.own.cap_invalid': 'code_own_cap_invalid',
  'agents.own.template_unknown': 'code_own_template_unknown',
  'agents.own.not_found': 'code_own_not_found',
  'agents.own.name_unset': 'code_own_name_unset',
  'agents.spend.cap_unset': 'code_spend_cap_unset',
} as const;
const wordsKey = (code: string) => (Object.hasOwn(CODE_WORDS, code) ? CODE_WORDS[code as keyof typeof CODE_WORDS] : null);

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/** The service's own refusals arrive as an `agents.` code; anything else (a timeout, a gateway answer) is not a refusal. */
const refusalCode = (failed: Failed): string | null =>
  failed.reason === 'error' && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** A refusal as words, with its code beside them so support can find it. */
function Refusal({ code, name = '' }: { code: string; name?: string }) {
  const { t } = agentBuilderCopy.useCopy();
  const key = wordsKey(code);
  const words = code === 'agents.own.reserved_name' ? t('code_own_reserved_name', { name }) : key ? t(key) : t('code_other');
  return (
    <p role="alert">
      {words} <code lang="zxx">{code}</code>
    </p>
  );
}
/** What a failed write says: the service's refusal in words, or the app's own account of a write it could not confirm. */
function Answer({ failed, name }: { failed: Failed; name?: string }) {
  const code = refusalCode(failed);
  return code ? <Refusal code={code} {...(name === undefined ? {} : { name })} /> : <Failure result={failed} />;
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

const PAGES = ['Build', 'Limits', 'Test', 'Usage', 'Identity', 'Sharing'] as const;

/** /agents/<id>: one of the person's own agents, on its pages. */
export function OwnAgentPage({ id }: { id: string }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [page, setPage] = useState<string>('Build');
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
            ) : (
              <Panel title={t(`page_${page as (typeof PAGES)[number]}`)}>
                <p role="note">{t(`parked_${page as Exclude<(typeof PAGES)[number], 'Build'>}`)}</p>
              </Panel>
            )}
          </div>
        );
      }}
    </Read>
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
