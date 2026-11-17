import { useState } from 'react';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Dialog, Failure, Field, Panel } from '../../shared/ui';
import { Read } from './common';
import { agentMemoryCopy } from './agent-memory-copy';
import type { Failed } from './AgentGuardrails';
import {
  ownAgentMemorySchema,
  ownAgentPrivacySchema,
  ownAgentShareCheckSchema,
  ownAgentShareSchema,
  type OwnAgent,
  type OwnAgentMemory,
  type OwnAgentPrivacy,
  type OwnAgentShare,
  type OwnAgentShareCheck,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's Memory and Privacy pages and the privacy check before sharing it (AG-builder-02, AG-guardrails-04;
 * J-agents-09). Every item, period and decision shown is svc-agents' own; the page never works one out, and a blank
 * retention period reads "not set". Nothing here moves money.
 */

const KNOWN = new Set([
  'agents.retention_unset',
  'agents.memory.not_found',
  'agents.privacy.confirm_required',
  'agents.share.no_co_owners',
  'agents.own.not_found',
]);

function Refused({ failed }: { failed: Failed }) {
  const { t } = agentMemoryCopy.useCopy();
  const code = /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;
  if (!code) return <Failure result={failed} />;
  return (
    <p role="alert">
      {KNOWN.has(code) ? t(`code_${code.replaceAll('.', '_')}` as 'code_other') : t('code_other')} <code lang="zxx">{code}</code>
    </p>
  );
}

/** A short, stable name for a run: the start of its id. */
const shortRun = (id: string) => id.slice(0, 8);

/** The Memory page: memory on or off, and each remembered item with its source run and a Clear control. */
export function MemoryPage({ agent, onOpenRun }: { agent: OwnAgent; onOpenRun: (runId: string) => void }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.memory.get', { id: agent.id, limit: 200 }, ownAgentMemorySchema, { signal }),
    `own-memory:${agent.id}`,
  );
  return (
    <Panel title={t('memoryTitle')} role="region" aria-label={t('memoryTitle')}>
      <p className="muted">{t('memoryIntro')}</p>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(stored) => <Memory agent={agent} stored={stored} onOpenRun={onOpenRun} />}
      </Read>
    </Panel>
  );
}

function Memory({ agent, stored, onOpenRun }: { agent: OwnAgent; stored: OwnAgentMemory; onOpenRun: (runId: string) => void }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const [memory, setMemory] = useState(stored);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setEnabled(enabled: boolean) {
    const before = memory;
    setBusy(true);
    setRefused(null);
    setCleared(false);
    // The switch follows the press at once; a refusal puts it back as svc-agents has it.
    setMemory({ ...memory, enabled });
    const res = await api.mutate('agents', 'own.memory.setEnabled', { id: agent.id, enabled }, ownAgentMemorySchema);
    setBusy(false);
    if (!res.ok) {
      setMemory(before);
      return setRefused(res);
    }
    setMemory(res.data);
  }

  async function clear(itemId: string) {
    setBusy(true);
    setRefused(null);
    setCleared(false);
    const res = await api.mutate('agents', 'own.memory.clear', { id: agent.id, itemId }, ownAgentMemorySchema);
    if (!res.ok) {
      // Gone already (a lost reply, or another tab): read what is stored rather than act again.
      const again = await api.query('agents', 'own.memory.get', { id: agent.id, limit: 200 }, ownAgentMemorySchema);
      if (again.ok) setMemory(again.data);
      setBusy(false);
      return setRefused(res);
    }
    setBusy(false);
    setMemory(res.data);
    setCleared(true);
  }

  return (
    <>
      <Field
        type="checkbox"
        role="switch"
        label={t('rememberSwitch')}
        hint={t(memory.enabled ? 'rememberOnHint' : 'rememberOffHint')}
        checked={memory.enabled}
        aria-checked={memory.enabled}
        disabled={busy}
        onChange={(event) => void setEnabled(event.target.checked)}
      />
      <p className="muted" data-testid="memory-state">
        {t(memory.enabled ? 'memoryState_on' : 'memoryState_off')}
      </p>
      <DataTable label={t('itemsTable')} headers={[t('colItem'), t('colSource'), t('colWhen'), t('colClear')]}>
        {memory.items.map((item) => (
          <tr key={item.id} data-item-id={item.id}>
            <td>{item.text}</td>
            <td>
              <a
                className="text-link"
                href={`#test-run-${item.sourceRunId}`}
                data-run-id={item.sourceRunId}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenRun(item.sourceRunId);
                }}
              >
                {t('sourceRun', { run: shortRun(item.sourceRunId) })}
              </a>
            </td>
            <td>{new Date(item.createdAt).toLocaleString()}</td>
            <td>
              <Button variant="ghost" disabled={busy} onClick={() => void clear(item.id)}>
                {t('clear')}
              </Button>
            </td>
          </tr>
        ))}
      </DataTable>
      {memory.items.length === 0 ? <p className="muted">{t('noItems')}</p> : null}
      {cleared ? <p role="status">{t('cleared')}</p> : null}
      {refused ? <Refused failed={refused} /> : null}
    </>
  );
}

/** The Privacy page: what is kept and for how long, each period the owner's or "not set", and the transcript control. */
export function PrivacyPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.privacy.get', { id: agent.id }, ownAgentPrivacySchema, { signal }),
    `own-privacy:${agent.id}`,
  );
  return (
    <Panel title={t('privacyTitle')} role="region" aria-label={t('privacyTitle')}>
      <p className="muted">{t('privacyIntro')}</p>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(stored) => <Privacy agent={agent} stored={stored} />}
      </Read>
    </Panel>
  );
}

function Privacy({ agent, stored }: { agent: OwnAgent; stored: OwnAgentPrivacy }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const [privacy, setPrivacy] = useState(stored);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);

  async function keepTranscripts(keep: boolean) {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate('agents', 'own.privacy.keepTranscripts', { id: agent.id, keep }, ownAgentPrivacySchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setPrivacy(res.data);
  }

  return (
    <>
      <DataTable label={t('retentionTable')} headers={[t('colKept'), t('colPeriod')]}>
        {privacy.periods.map((period) => (
          <tr key={period.kind} data-kind={period.kind}>
            <td>{t(`kind_${period.kind}`)}</td>
            <td data-testid="retention-period">{period.days === null ? t('notSet') : t('periodDays', { days: String(period.days) })}</td>
          </tr>
        ))}
      </DataTable>
      <p className="muted">{t(privacy.memoryEnabled ? 'memoryState_on' : 'memoryState_off')}</p>
      <Field
        type="checkbox"
        role="switch"
        label={t('keepTranscripts')}
        hint={t('keepTranscriptsHint')}
        checked={privacy.keepTranscripts}
        aria-checked={privacy.keepTranscripts}
        disabled={busy}
        onChange={(event) => void keepTranscripts(event.target.checked)}
      />
      {refused ? <Refused failed={refused} /> : null}
    </>
  );
}

/**
 * Sharing the agent with its co-owners, behind the privacy check: the check lists what they would see, and nothing is
 * shared until the person confirms it. Cancel shares nothing.
 */
export function ShareWithCoOwners({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.share.get', { id: agent.id }, ownAgentShareSchema, { signal }),
    `own-share:${agent.id}`,
  );
  return (
    <Panel title={t('shareTitle')} role="region" aria-label={t('shareTitle')}>
      <p className="muted">{t('shareIntro')}</p>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(stored) => <Share agent={agent} stored={stored} />}
      </Read>
    </Panel>
  );
}

function Share({ agent, stored }: { agent: OwnAgent; stored: OwnAgentShare }) {
  const api = useApi();
  const { t } = agentMemoryCopy.useCopy();
  const [share, setShare] = useState(stored);
  const [transcripts, setTranscripts] = useState(stored.includeTranscripts);
  const [memory, setMemory] = useState(stored.includeMemory);
  const [check, setCheck] = useState<OwnAgentShareCheck | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);

  async function runCheck() {
    setBusy(true);
    setRefused(null);
    const res = await api.query(
      'agents',
      'own.share.check',
      { id: agent.id, includeTranscripts: transcripts, includeMemory: memory },
      ownAgentShareCheckSchema,
    );
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setCheck(res.data);
  }

  async function confirm() {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.share.set',
      { id: agent.id, includeTranscripts: transcripts, includeMemory: memory, confirmed: true },
      ownAgentShareSchema,
    );
    setBusy(false);
    setCheck(null);
    if (!res.ok) return setRefused(res);
    setShare(res.data);
  }

  const state = !share.shared ? 'shareState_none' : share.includeTranscripts ? 'shareState_transcripts' : 'shareState_shared';
  return (
    <>
      <p>
        <span data-testid="share-state">{t(state)}</span>
      </p>
      {/* The page's reset gives a checkbox no size; the builder's choice class gives it one a person can tick. */}
      <label className="agent-surface-choice">
        <input type="checkbox" checked={transcripts} onChange={(event) => setTranscripts(event.target.checked)} /> {t('includeTranscripts')}
      </label>
      <label className="agent-surface-choice">
        <input type="checkbox" checked={memory} onChange={(event) => setMemory(event.target.checked)} /> {t('includeMemory')}
      </label>
      <Button disabled={busy} onClick={() => void runCheck()}>
        {t('share')}
      </Button>
      {refused ? <Refused failed={refused} /> : null}
      {check ? (
        <Dialog title={t('checkTitle')} onClose={() => setCheck(null)}>
          <p>{t('checkIntro', { count: String(check.coOwners) })}</p>
          {check.exposes.length ? (
            <ul>
              {check.exposes.map((exposed) => (
                <li key={exposed} data-exposes={exposed}>
                  {t(`exposes_${exposed}`)}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('checkNothing')}</p>
          )}
          <Button disabled={busy} onClick={() => void confirm()}>
            {t('confirmShare')}
          </Button>
          <Button variant="secondary" onClick={() => setCheck(null)}>
            {t('cancel')}
          </Button>
        </Dialog>
      ) : null}
    </>
  );
}
