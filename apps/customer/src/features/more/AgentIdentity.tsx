import { useRef, useState } from 'react';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Panel } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import { identityWordsKey } from './new-agent/assistant-words';
import { type OwnAgent, type OwnAgentProposal, type OwnAgentToken } from '@intafaced/contracts/agents-own';
import {
  AGENTS_OWN_CATALOGUE,
  AGENTS_OWN_CREATE,
  AGENTS_OWN_IDENTITY_GET,
  AGENTS_OWN_IDENTITY_ISSUE,
  AGENTS_OWN_IDENTITY_REVOKE,
  AGENTS_OWN_ASSISTANT_STATE,
  AGENTS_OWN_ASSISTANT_DRAFT,
  AGENTS_OWN_ASSISTANT_ACCEPT,
} from '@intafaced/contracts/agents-own-procedures';

/**
 * An own agent's Identity page (AG-identity-01; J-agents-03 #5), and the calls of the New agent room (`new-agent/`):
 * its template picker and the builder's drafting assistant (AG-builder-03; J-agents-03 #6), which that room draws. Every
 * answer is svc-agents' own: the token's owner, scopes and expiry as it holds them; a refusal with its code. Nothing here
 * moves money.
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

/** The Identity page: the agent's token as svc-agents holds it, issued once and revocable. */
export function IdentityPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const loaded = useResource((signal) => api.call(AGENTS_OWN_IDENTITY_GET, { id: agent.id }, { signal }), `own-identity:${agent.id}`);
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
    const res = await api.call(AGENTS_OWN_IDENTITY_ISSUE, { id: agent.id });
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setChanged(res.data.token);
    setSecret(res.data.secret);
  }
  async function revoke() {
    setBusy(true);
    setRefused(null);
    setStatus(null);
    const res = await api.call(AGENTS_OWN_IDENTITY_REVOKE, { id: agent.id });
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
 * The New agent room's template picker: the templates the service offers (AG-catalogue-02), and a press that makes a
 * draft of one and opens it, or holds the refusal.
 */
export function useAgentPicker() {
  const api = useApi();
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // The templates the service offers (AG-catalogue-02): a template it does not offer has no button.
  const catalogue = useResource((signal) => api.call(AGENTS_OWN_CATALOGUE, undefined, { signal }), 'own-catalogue');
  // This visit's key for each template: pressing again after an answer that never arrived returns the draft the first
  // press made, rather than a second one. Each visit to the picker is a new draft.
  const visit = useRef(`picker:${crypto.randomUUID()}`);
  async function start(template: string) {
    setBusy(true);
    setRefused(null);
    const res = await api.call(AGENTS_OWN_CREATE, { template, createKey: `${visit.current}:${template}` });
    setBusy(false);
    if (res.ok) navigate(`/agents/${res.data.id}`, true);
    else setRefused(res);
  }
  return { catalogue, refused, busy, start };
}

/**
 * The builder's drafting assistant, as the New agent room draws it. While the owner has not chosen the model the
 * engine is null and it drafts nothing; the rest of the builder works without it. A draft is shown with its tools,
 * which passed the check a save meets, and nothing is saved until the person accepts it.
 */
export function useAssistant() {
  const api = useApi();
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
  return { state, engine, description, setDescription, proposal, setProposal, refused, busy, draft, accept };
}
