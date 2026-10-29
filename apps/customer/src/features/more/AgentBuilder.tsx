import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Dialog, Field, Panel, Tabs } from '../../shared/ui';
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

/** /agents/new: pick a template, which makes a draft, then build it. Nothing here moves money. */
export function NewAgent() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [draft, setDraft] = useState<OwnAgent | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function start(template: string) {
    setBusy(true);
    setRefused(null);
    // One key per press: a retried request returns the draft this press made, and the next press makes the next draft.
    const res = await api.mutate('agents', 'own.create', { template, createKey: `picker:${crypto.randomUUID()}` }, ownAgentSchema);
    setBusy(false);
    if (res.ok) setDraft(res.data);
    else setRefused(res.message);
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
        {refused ? <Refusal code={refused} /> : null}
      </Panel>
      <Panel title={t('assistantTitle')} role="region" aria-label={t('assistantTitle')}>
        <p role="note">
          {t('assistantBlocked')} <code lang="zxx">owner.decision</code>
        </p>
        <Button disabled>{t('draftIt')}</Button>
      </Panel>
      {draft ? <Builder key={draft.id} agent={draft} onSaved={setDraft} /> : null}
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
  const [refused, setRefused] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  function add(tool: ToolEntry) {
    setPicking(false);
    setSaved(false);
    // The service refuses it on save too; saying so now spares a round trip.
    if (tool.movesMoney) return setRefused('agents.own.money_tool');
    setRefused(null);
    setTools((current) => (current.includes(tool.name) ? current : [...current, tool.name]));
  }
  async function save() {
    setBusy(true);
    setSaved(false);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.save',
      { id: agent.id, name, instructions, tools, perSessionCap: cap.trim() ? cap.trim() : null },
      ownAgentSchema.refine((row) => row.id === agent.id),
    );
    setBusy(false);
    if (!res.ok) return setRefused(res.message);
    setSaved(true);
    onSaved(res.data);
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
          <Field label={t('name')} value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
          <TextArea label={t('instructions')} value={instructions} maxLength={4000} onChange={setInstructions} />
          <Field label={t('cap')} hint={t('capHint')} inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
          <h3>{t('toolsTitle')}</h3>
          {tools.length ? (
            <ul aria-label={t('toolsTitle')}>
              {tools.map((tool) => (
                <li key={tool}>
                  <code lang="zxx">{tool}</code>{' '}
                  <Button variant="ghost" onClick={() => setTools((current) => current.filter((name) => name !== tool))}>
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
          {refused ? <Refusal code={refused} name={name.trim()} /> : null}
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

/** The page title of one of the person's own agents: its name, or that it has none yet. */
export function OwnAgentTitle({ id }: { id: string }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource((signal) => api.query('agents', 'own.get', { id }, ownAgentSchema, { signal }), `own-agent-title:${id}`);
  if (loaded.resource.status !== 'ready') return <>{t('ownAgent')}</>;
  return <>{loaded.resource.data.name || t('untitled')}</>;
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
