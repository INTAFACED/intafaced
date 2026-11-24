import { useRef, useState } from 'react';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Panel } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read, TextArea } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import { identityWordsKey } from './agent-room/IdentityPage';
import { type OwnAgentProposal } from '@intafaced/contracts/agents-own';
import {
  AGENTS_OWN_ASSISTANT_STATE,
  AGENTS_OWN_ASSISTANT_DRAFT,
  AGENTS_OWN_ASSISTANT_ACCEPT,
} from '@intafaced/contracts/agents-own-procedures';

/**
 * The builder's drafting assistant (AG-builder-03; J-agents-03 #6), on /agents/new; the Identity page (AG-identity-01;
 * J-agents-03 #5) is agent-room/IdentityPage.tsx. Every answer is svc-agents' own; a refusal comes with its code.
 * Nothing here moves money.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Words = ReturnType<typeof agentBuilderCopy.useCopy>['t'];

function Answer({ failed, t }: { failed: Failed; t: Words }) {
  const key = identityWordsKey(failed.message);
  return key ? (
    <p role="alert">
      {t(key)} <code lang="zxx">{failed.message}</code>
    </p>
  ) : (
    <Failure result={failed} />
  );
}

/**
 * The builder's drafting assistant. While the owner has not chosen the model it shows the owner-decision notice and
 * drafts nothing; the rest of the builder works without it. A draft is shown with its tools, which passed the check a
 * save meets, and nothing is saved until the person accepts it.
 */
export function AssistantPanel() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const state = useResource((signal) => api.call(AGENTS_OWN_ASSISTANT_STATE, undefined, { signal }), 'own-assistant');
  const [description, setDescription] = useState('');
  const [proposal, setProposal] = useState<OwnAgentProposal | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per draft shown: accepting again after an answer that never arrived returns the agent the first accept made.
  const acceptKey = useRef('');
  const engine = state.resource.status === 'ready' ? state.resource.data.engine : undefined;

  async function draft() {
    setBusy(true);
    setRefused(null);
    setProposal(null);
    const res = await api.call(AGENTS_OWN_ASSISTANT_DRAFT, { description });
    setBusy(false);
    if (!res.ok) return setRefused(res);
    acceptKey.current = `accept:${crypto.randomUUID()}`;
    setProposal(res.data);
  }
  async function accept(shown: OwnAgentProposal) {
    setBusy(true);
    setRefused(null);
    const res = await api.call(AGENTS_OWN_ASSISTANT_ACCEPT, {
      name: shown.name,
      instructions: shown.instructions,
      tools: shown.tools,
      acceptKey: acceptKey.current,
    });
    setBusy(false);
    if (res.ok) navigate(`/agents/${res.data.id}`, true);
    else setRefused(res);
  }

  return (
    <Panel title={t('assistantTitle')} role="region" aria-label={t('assistantTitle')}>
      {engine === null ? (
        <p role="note">
          {t('assistantBlocked')} <code lang="zxx">owner.decision</code>
        </p>
      ) : engine === 'live' ? (
        <p role="note">{t('assistantLive')}</p>
      ) : engine === 'test' ? (
        <p className="lt-muted">{t('assistantTest')}</p>
      ) : state.resource.status === 'failed' ? (
        <Read resource={state.resource} retry={state.reload}>
          {() => null}
        </Read>
      ) : null}
      <TextArea label={t('describeAgent')} value={description} maxLength={4000} onChange={setDescription} />
      <Button disabled={busy || !engine || !description.trim()} onClick={() => void draft()}>
        {t('draftIt')}
      </Button>
      {engine && !description.trim() ? <p className="lt-muted">{t('draftHint')}</p> : null}
      {proposal ? (
        <section aria-label={t('proposalTitle')}>
          <h3>{t('proposalTitle')}</h3>
          <p className="lt-muted">{t('proposalSaved')}</p>
          <dl>
            <dt>{t('name')}</dt>
            <dd data-testid="proposal-name">{proposal.name}</dd>
            <dt>{t('instructions')}</dt>
            <dd data-testid="proposal-instructions">{proposal.instructions}</dd>
          </dl>
          <ul aria-label={t('toolsTitle')}>
            {proposal.tools.map((tool) => (
              <li key={tool}>
                <code lang="zxx">{tool}</code>
              </li>
            ))}
          </ul>
          {proposal.leftOut.length ? (
            <ul aria-label={t('proposalLeftOut')}>
              {proposal.leftOut.map((row) => (
                <li key={row.tool}>
                  <code lang="zxx">{row.tool}</code> · <code lang="zxx">{row.code}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="depth-card-actions">
            <Button disabled={busy} onClick={() => void accept(proposal)}>
              {t('acceptDraft')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setProposal(null)}>
              {t('discardDraft')}
            </Button>
          </div>
        </section>
      ) : null}
      {refused ? <Answer failed={refused} t={t} /> : null}
    </Panel>
  );
}
