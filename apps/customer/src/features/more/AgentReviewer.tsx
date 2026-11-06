import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Read, Select } from './common';
import { Answer, toolWords, type Failed } from './AgentGuardrails';
import { agentGuardrailsCopy } from './agent-guardrails-copy';
import { agentReviewerCopy } from './agent-reviewer-copy';
import {
  ownAgentCatalogueSchema,
  ownAgentReviewCheckSchema,
  ownAgentReviewerSchema,
  ownAgentReviewRowSchema,
  type OwnAgent,
  type OwnAgentReviewCheck,
  type OwnAgentReviewer,
  type OwnAgentReviewRow,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's automatic reviewer, on its Rules page (AG-approvals-02; J-agents-05 #7): the person's switch, the
 * reviewer's engine as svc-agents reports it (the owner-decision notice while the owner has not chosen the model), the
 * reviewer's decisions with their coded reasons, and a check of what it would decide for one call. Every answer comes
 * from svc-agents. Nothing here moves money.
 */

const rowsSchema = z.array(ownAgentReviewRowSchema);
const SHOWN = 50;

export function ReviewerPanel({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentReviewerCopy.useCopy();
  const setting = useResource(
    (signal) => api.query('agents', 'own.reviewer.get', { id: agent.id }, ownAgentReviewerSchema, { signal }),
    `own-reviewer:${agent.id}`,
  );
  const decisions = useResource(
    (signal) => api.query('agents', 'own.review.list', { id: agent.id, limit: SHOWN }, rowsSchema, { signal }),
    `own-reviews:${agent.id}`,
  );
  return (
    <>
      <Panel title={t('title')} role="region" aria-label={t('title')}>
        <p className="muted">{t('intro')}</p>
        <p>{t('valueAlwaysAsks')}</p>
        <Read resource={setting.resource} retry={setting.reload}>
          {(stored) => <ReviewerSwitch agent={agent} stored={stored} />}
        </Read>
        <h3>{t('decisionsTitle')}</h3>
        <Read resource={decisions.resource} retry={decisions.reload}>
          {(rows) => <Decisions rows={rows} />}
        </Read>
      </Panel>
      <ReviewerCheck agent={agent} />
    </>
  );
}

function EngineNote({ engine }: { engine: OwnAgentReviewer['engine'] }) {
  const { t } = agentReviewerCopy.useCopy();
  if (engine === null) {
    return (
      <p role="note">
        <code lang="zxx">owner.decision</code> {t('ownerDecision')}
      </p>
    );
  }
  return <p role="note">{t(engine === 'test' ? 'engineTest' : 'engineLive')}</p>;
}

function ReviewerSwitch({ agent, stored }: { agent: OwnAgent; stored: OwnAgentReviewer }) {
  const api = useApi();
  const { t } = agentReviewerCopy.useCopy();
  const [current, setCurrent] = useState(stored);
  const [changed, setChanged] = useState(false);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    setChanged(false);
    setRefused(null);
    const res = await api.mutate('agents', 'own.reviewer.set', { id: agent.id, on: !current.on }, ownAgentReviewerSchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setCurrent(res.data);
    setChanged(true);
  }
  return (
    <>
      <EngineNote engine={current.engine} />
      <p>
        <button
          type="button"
          role="switch"
          aria-checked={current.on}
          aria-label={t('switchLabel')}
          disabled={busy}
          onClick={() => void toggle()}
        >
          {t(current.on ? 'on' : 'off')}
        </button>{' '}
        {t('switchLabel')}
      </p>
      {changed ? <p role="status">{t(current.on ? 'turnedOn' : 'turnedOff')}</p> : null}
      {refused ? <Answer failed={refused} /> : null}
    </>
  );
}

function Decisions({ rows }: { rows: OwnAgentReviewRow[] }) {
  const { t } = agentReviewerCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  if (!rows.length) return <p className="muted">{t('decisionsEmpty')}</p>;
  return (
    <DataTable label={t('decisionsTitle')} headers={[t('colWhen'), t('colTool'), t('colDecision'), t('colReason'), t('colInput')]}>
      {rows.map((row) => (
        <tr key={row.id} data-review-id={row.id} data-request-id={row.requestId}>
          <td>{new Date(row.createdAt).toLocaleString()}</td>
          <td>{toolWords(tools, row.tool)}</td>
          <td>{t(`decision_${row.decision}`)}</td>
          <td>
            <code lang="zxx">{row.reasonCode}</code>
          </td>
          <td>
            <code lang="zxx" title={row.inputDigest}>
              {row.inputDigest.slice(0, 19)}
            </code>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

function ReviewerCheck({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentReviewerCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const catalogue = useResource(
    (signal) => api.query('agents', 'own.catalogue', undefined, ownAgentCatalogueSchema, { signal }),
    'own-catalogue',
  );
  const [tool, setTool] = useState('');
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<OwnAgentReviewCheck | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(name: string) {
    setBusy(true);
    setAnswer(null);
    setRefused(null);
    const res = await api.query(
      'agents',
      'own.review.check',
      { id: agent.id, tool: name, input: text ? { text } : {} },
      ownAgentReviewCheckSchema,
    );
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setAnswer(res.data);
  }
  return (
    <Panel title={t('checkTitle')} role="region" aria-label={t('checkTitle')}>
      <p className="muted">{t('checkIntro')}</p>
      <Read resource={catalogue.resource} retry={catalogue.reload}>
        {(offered) => {
          const chosen = tool || offered.tools[0]?.name || '';
          return (
            <>
              <Select
                label={t('checkTool')}
                value={chosen}
                onChange={(value) => {
                  setTool(value);
                  setAnswer(null);
                }}
                options={offered.tools.map((entry) => ({ value: entry.name, label: toolWords(tools, entry.name) }))}
              />
              <Field label={t('checkInput')} value={text} maxLength={4000} onChange={(event) => setText(event.target.value)} />
              <Button disabled={busy || !chosen} onClick={() => void ask(chosen)}>
                {t('checkButton')}
              </Button>
            </>
          );
        }}
      </Read>
      {answer ? (
        <p role="status" data-testid="review-check">
          {t('checkAnswer', { tool: toolWords(tools, answer.tool), decision: t(`decision_${answer.review.decision}`) })}{' '}
          <code lang="zxx">{answer.review.reasonCode}</code>
        </p>
      ) : null}
      {refused ? <Answer failed={refused} /> : null}
    </Panel>
  );
}
