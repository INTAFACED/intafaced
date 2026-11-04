import { useRef, useState } from 'react';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Panel } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read, TextArea } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import {
  ownAgentAssistantSchema,
  ownAgentIdentitySchema,
  ownAgentIssuedTokenSchema,
  ownAgentProposalSchema,
  ownAgentSchema,
  ownAgentTokenSchema,
  type OwnAgent,
  type OwnAgentProposal,
  type OwnAgentToken,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's Identity page (AG-identity-01; J-agents-03 #5) and the builder's drafting assistant (AG-builder-03;
 * J-agents-03 #6). Every answer is svc-agents' own: the token's owner, scopes and expiry as it holds them; a refusal
 * with its code. Nothing here moves money.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Words = ReturnType<typeof agentBuilderCopy.useCopy>['t'];

/** The codes this page words; any other failure is the app's own account of it. */
const CODE_WORDS = {
  'owner.decision': 'code_owner_decision',
  'agents.assistant.engine_unavailable': 'code_assistant_engine_unavailable',
  'agents.assistant.description_blank': 'code_assistant_description_blank',
  'agents.identity.lifetime_unset': 'code_identity_lifetime_unset',
  'agents.identity.no_live_token': 'code_identity_no_live_token',
  'agents.tool_shape_missing': 'code_tool_shape_missing',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.too_many': 'code_own_too_many',
  'agents.own.not_found': 'code_own_not_found',
} as const;

function Answer({ failed, t }: { failed: Failed; t: Words }) {
  const key = Object.hasOwn(CODE_WORDS, failed.message) ? CODE_WORDS[failed.message as keyof typeof CODE_WORDS] : null;
  return key ? (
    <p role="alert">
      {t(key)} <code lang="zxx">{failed.message}</code>
    </p>
  ) : (
    <Failure result={failed} />
  );
}

/** The Identity page: the agent's token as svc-agents holds it, issued once and revocable. */
export function IdentityPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource(
    (signal) => api.query('agents', 'own.identity.get', { id: agent.id }, ownAgentIdentitySchema, { signal }),
    `own-identity:${agent.id}`,
  );
  // The token after this visit's issue or revoke; undefined until one, so the read is shown.
  const [changed, setChanged] = useState<OwnAgentToken | undefined>(undefined);
  const [secret, setSecret] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    setRefused(null);
    setStatus(null);
    const res = await api.mutate('agents', 'own.identity.issue', { id: agent.id }, ownAgentIssuedTokenSchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setChanged(res.data.token);
    setSecret(res.data.secret);
  }
  async function revoke() {
    setBusy(true);
    setRefused(null);
    setStatus(null);
    const res = await api.mutate('agents', 'own.identity.revoke', { id: agent.id }, ownAgentTokenSchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setChanged(res.data);
    setSecret(null);
    setStatus(t('tokenRevoked'));
  }

  return (
    <Panel title={t('identityTitle')} role="region" aria-label={t('identityTitle')}>
      <p className="muted">{t('identityIntro')}</p>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(read) => {
          const token = changed ?? read.token;
          return (
            <>
              {token ? (
                <dl data-testid="agent-token-facts">
                  <dt>{t('identityOwner')}</dt>
                  <dd data-testid="token-owner">{token.ownerId}</dd>
                  <dt>{t('identityScopes')}</dt>
                  <dd data-testid="token-scopes">
                    {token.scopes.length ? (
                      <ul aria-label={t('identityScopes')}>
                        {token.scopes.map((scope) => (
                          <li key={scope}>
                            <code lang="zxx">{scope}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      t('identityNoScopes')
                    )}
                  </dd>
                  <dt>{t('identityIssued')}</dt>
                  <dd>
                    <time dateTime={token.issuedAt}>{new Date(token.issuedAt).toLocaleString()}</time>
                  </dd>
                  <dt>{t('identityExpires')}</dt>
                  <dd>
                    <time data-testid="token-expires" dateTime={token.expiresAt}>
                      {new Date(token.expiresAt).toLocaleString()}
                    </time>
                  </dd>
                  <dt>{t('identityState')}</dt>
                  <dd data-testid="token-state">{t(`tokenState_${token.state}`)}</dd>
                </dl>
              ) : (
                <p>{t('identityNone')}</p>
              )}
              {secret ? (
                <p>
                  {t('tokenOnce')}{' '}
                  <code lang="zxx" data-testid="agent-token">
                    {secret}
                  </code>
                </p>
              ) : null}
              <div className="depth-card-actions">
                <Button disabled={busy} onClick={() => void issue()}>
                  {token ? t('reissueToken') : t('issueToken')}
                </Button>
                <Button variant="secondary" disabled={busy || token?.state !== 'active'} onClick={() => void revoke()}>
                  {t('revokeToken')}
                </Button>
              </div>
            </>
          );
        }}
      </Read>
      {status ? <p role="status">{status}</p> : null}
      {refused ? <Answer failed={refused} t={t} /> : null}
    </Panel>
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
  const state = useResource(
    (signal) => api.query('agents', 'own.assistant.state', undefined, ownAgentAssistantSchema, { signal }),
    'own-assistant',
  );
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
    const res = await api.mutate('agents', 'own.assistant.draft', { description }, ownAgentProposalSchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    acceptKey.current = `accept:${crypto.randomUUID()}`;
    setProposal(res.data);
  }
  async function accept(shown: OwnAgentProposal) {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate(
      'agents',
      'own.assistant.accept',
      { name: shown.name, instructions: shown.instructions, tools: shown.tools, acceptKey: acceptKey.current },
      ownAgentSchema,
    );
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
        <p className="muted">{t('assistantTest')}</p>
      ) : state.resource.status === 'failed' ? (
        <Read resource={state.resource} retry={state.reload}>
          {() => null}
        </Read>
      ) : null}
      <TextArea label={t('describeAgent')} value={description} maxLength={4000} onChange={setDescription} />
      <Button disabled={busy || !engine || !description.trim()} onClick={() => void draft()}>
        {t('draftIt')}
      </Button>
      {proposal ? (
        <section aria-label={t('proposalTitle')}>
          <h3>{t('proposalTitle')}</h3>
          <p className="muted">{t('proposalSaved')}</p>
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
