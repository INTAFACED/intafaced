// The Identity page of one of the person's own agents, on the kit (the room is OwnAgentRoom.tsx).
import { useState } from 'react';
import { useApi } from '../../session';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { Button } from '@intafaced/ui/lit';
import { Failure, Panel, Read } from './parts';
import { agentBuilderCopy } from '../agent-builder-copy';
import { type OwnAgent, type OwnAgentToken } from '@intafaced/contracts/agents-own';
import { AGENTS_OWN_IDENTITY_GET, AGENTS_OWN_IDENTITY_ISSUE, AGENTS_OWN_IDENTITY_REVOKE } from '@intafaced/contracts/agents-own-procedures';

/**
 * An own agent's Identity page (AG-identity-01; J-agents-03 #5). Every answer is svc-agents' own: the token's owner,
 * scopes and expiry as it holds them; a refusal with its code. Nothing here moves money.
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
  'agents.identity.owner_frozen': 'code_identity_owner_frozen',
  'agents.identity.owner_inactive': 'code_identity_owner_inactive',
  'agents.identity.owner_unread': 'code_identity_owner_unread',
  'agents.tool_shape_missing': 'code_tool_shape_missing',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.too_many': 'code_own_too_many',
  'agents.own.not_found': 'code_own_not_found',
} as const;

/** The words key for a code this page words, or null. */
export const identityWordsKey = (code: string) => (Object.hasOwn(CODE_WORDS, code) ? CODE_WORDS[code as keyof typeof CODE_WORDS] : null);

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
      <p className="lt-muted">{t('identityIntro')}</p>
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
              <div className="lt-actions">
                <Button tone="primary" disabled={busy} onClick={() => void issue()}>
                  {token ? t('reissueToken') : t('issueToken')}
                </Button>
                <Button tone="secondary" disabled={busy || token?.state !== 'active'} onClick={() => void revoke()}>
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
