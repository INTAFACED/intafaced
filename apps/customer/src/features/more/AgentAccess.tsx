import { useId, useMemo, useState } from 'react';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Failure, Field, Panel } from '../../shared/ui';
import { useVenueMode, venueApi, VenueFrame, WalletBar, useOwner } from '../trade';
import { Read, Select } from './common';
import { agentAccessCopy } from './agent-access-copy';
import type { Failed } from './AgentGuardrails';
import {
  OWN_AGENT_POLICY_ACTIONS,
  OWN_AGENT_POLICY_EFFECTS,
  OWN_AGENT_POLICY_SCOPES,
  ownAgentPolicySchema,
  type OwnAgentAccess,
  type OwnAgent,
  type OwnAgentPolicy,
  type OwnAgentPolicyAction,
  type OwnAgentPolicyEffect,
  type OwnAgentPolicyScope,
} from '@intafaced/contracts/agents-own';
import {
  AGENTS_OWN_POLICY_GET,
  AGENTS_OWN_ACCESS_GET,
  AGENTS_OWN_ACCESS_GRANT,
  AGENTS_OWN_POLICY_ADD,
  AGENTS_OWN_POLICY_REMOVE,
  AGENTS_OWN_POLICY_REQUIRE,
} from '@intafaced/contracts/agents-own-procedures';
import { callAs, type AppProcedure } from '../../shared/api';

/**
 * An own agent's Access page (AG-spend-02, J-agents-08 #1 #2): the person's allow and deny rules by action and account,
 * what svc-agents decides from them for each action on the main account, and which of the person's venue sub-accounts
 * the agent may act on until when. Every decision shown is the service's own; the page never works one out. Nothing here
 * moves money.
 */

const KNOWN = new Set([
  'agents.policy_rule_not_found',
  'agents.own.not_found',
  'agents.access_expiry_unset',
  'agents.access_expiry_invalid',
  'agents.access_none_chosen',
  'agents.access_request_invalid',
]);

function Refused({ failed }: { failed: Failed }) {
  const { t } = agentAccessCopy.useCopy();
  const code = /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;
  if (!code) return <Failure result={failed} />;
  return (
    <p role="alert">
      {KNOWN.has(code) ? t(`code_${code.replaceAll('.', '_')}` as 'code_other') : t('code_other')} <code lang="zxx">{code}</code>
    </p>
  );
}

export function AccessPage({ agent }: { agent: OwnAgent }) {
  const api = useApi();
  const { t } = agentAccessCopy.useCopy();
  const loaded = useResource((signal) => api.call(AGENTS_OWN_POLICY_GET, { id: agent.id }, { signal }), `own-policy:${agent.id}`);
  return (
    <Panel title={t('accessTitle')} role="region" aria-label={t('accessTitle')}>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(policy) => <Policy agent={agent} stored={policy} />}
      </Read>
      <AccountAccess agent={agent} />
    </Panel>
  );
}

/**
 * Which of the person's venue sub-accounts the agent may act on (J-agents-08 #2). The sub-accounts are the venue's own
 * list for the connected wallet; the grant and its end are svc-agents'. With the venue off, the section says so.
 */
function AccountAccess({ agent }: { agent: OwnAgent }) {
  const { t } = agentAccessCopy.useCopy();
  const mode = useVenueMode();
  return (
    <section role="region" aria-label={t('accountAccessTitle')}>
      <h3>{t('accountAccessTitle')}</h3>
      <p className="lt-muted">{t('accountAccessIntro')}</p>
      {mode.mode === 'on' ? (
        <VenueFrame mode={mode}>
          <AccountAccessGrant agent={agent} venueId={mode.status.available ? mode.status.venue.id : null} />
        </VenueFrame>
      ) : mode.mode === 'checking' ? (
        <p className="lt-muted">{t('accountAccessChecking')}</p>
      ) : (
        <p className="lt-muted">{t('accountAccessOff')}</p>
      )}
    </section>
  );
}

function AccountAccessGrant({ agent, venueId }: { agent: OwnAgent; venueId: string | null }) {
  const api = useApi();
  const { t } = agentAccessCopy.useCopy();
  const venue = useMemo(() => venueApi(api), [api]);
  const owner = useOwner();
  const subs = useResource(
    (signal) => (owner ? venue.subAccounts(owner, signal) : Promise.resolve({ ok: true as const, data: null })),
    `venue-subs:${owner ?? 'none'}`,
  );
  const stored = useResource((signal) => api.call(AGENTS_OWN_ACCESS_GET, { id: agent.id }, { signal }), `own-access:${agent.id}`);
  const [access, setAccess] = useState<OwnAgentAccess | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [endsIn, setEndsIn] = useState('');
  // One key per grant the person is writing: a retried press is the same grant; a new one starts after an answer.
  const [grantKey, setGrantKey] = useState(() => crypto.randomUUID());
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = access ?? (stored.resource.status === 'ready' ? stored.resource.data : null);
  const listed = subs.resource.status === 'ready' ? subs.resource.data : null;

  async function grant() {
    if (!owner || !venueId || !listed) return;
    setBusy(true);
    setRefused(null);
    try {
      const subAccounts = listed.value.filter((s) => chosen.has(s.subAccount));
      const res = await api.call(AGENTS_OWN_ACCESS_GRANT, {
        id: agent.id,
        grantKey,
        venueId,
        owner,
        subAccounts,
        endsInDays: endsIn.trim() === '' ? null : endsIn.trim(),
      });
      if (!res.ok) return setRefused(res);
      setAccess(res.data);
      setGrantKey(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <WalletBar />
      {!owner ? (
        <p className="lt-muted">{t('connectFirst')}</p>
      ) : subs.resource.status === 'failed' ? (
        <p role="alert">{t('subAccountsRefused')}</p>
      ) : listed && listed.value.length === 0 ? (
        <p className="lt-muted">{t('noSubAccounts')}</p>
      ) : listed ? (
        <form
          aria-label={t('accountAccessTitle')}
          onSubmit={(event) => {
            event.preventDefault();
            void grant();
          }}
        >
          {listed.value.map((sub) => (
            <label key={sub.subAccount} className="agent-surface-choice">
              <input
                type="checkbox"
                checked={chosen.has(sub.subAccount)}
                disabled={busy}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(sub.subAccount);
                  else next.delete(sub.subAccount);
                  setChosen(next);
                }}
              />
              <span>{sub.name}</span>
            </label>
          ))}
          <Field
            label={t('endsIn')}
            hint={t('endsInHint')}
            inputMode="numeric"
            value={endsIn}
            disabled={busy}
            onChange={(event) => setEndsIn(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {t('grantAccess')}
          </Button>
          {refused ? <Refused failed={refused} /> : null}
        </form>
      ) : null}
      {shown && shown.grants.length ? (
        <DataTable label={t('grantedTable')} headers={[t('colAccount'), t('colEnds')]}>
          {shown.grants.map((g) => (
            <tr key={g.id}>
              <td>{g.name}</td>
              <td data-testid="access-ends">
                <time dateTime={g.endsAt}>{new Date(g.endsAt).toLocaleString()}</time>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : shown ? (
        <p className="lt-muted">{t('noGrants')}</p>
      ) : null}
    </>
  );
}

function Policy({ agent, stored }: { agent: OwnAgent; stored: OwnAgentPolicy }) {
  const api = useApi();
  const { t } = agentAccessCopy.useCopy();
  const requiredId = useId();
  const [policy, setPolicy] = useState(stored);
  const [effect, setEffect] = useState<OwnAgentPolicyEffect>('allow');
  const [action, setAction] = useState<OwnAgentPolicyAction>('place_order');
  const [scope, setScope] = useState<OwnAgentPolicyScope>('all');
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // The tick shows the person's choice at once; the service's answer then sets it, or a refusal puts it back.
  const [required, setRequired] = useState(stored.rulesRequired);
  async function send(procedure: AppProcedure, input: Record<string, unknown>) {
    setBusy(true);
    setRefused(null);
    try {
      const res = await callAs(api, procedure, { id: agent.id, ...input }, ownAgentPolicySchema);
      if (!res.ok) {
        setRequired(policy.rulesRequired);
        return setRefused(res);
      }
      setPolicy(res.data);
      setRequired(res.data.rulesRequired);
    } catch (error) {
      setRequired(policy.rulesRequired);
      throw error;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="lt-muted">{t('accessIntro')}</p>
      <form
        aria-label={t('newRule')}
        onSubmit={(event) => {
          event.preventDefault();
          void send(AGENTS_OWN_POLICY_ADD, { effect, action, scope });
        }}
      >
        <Select
          label={t('effect')}
          value={effect}
          onChange={(value) => setEffect(value as OwnAgentPolicyEffect)}
          options={OWN_AGENT_POLICY_EFFECTS.map((value) => ({ value, label: t(`effect_${value}`) }))}
        />
        <Select
          label={t('action')}
          value={action}
          onChange={(value) => setAction(value as OwnAgentPolicyAction)}
          options={OWN_AGENT_POLICY_ACTIONS.map((value) => ({ value, label: t(`action_${value}`) }))}
        />
        <Select
          label={t('scope')}
          value={scope}
          onChange={(value) => setScope(value as OwnAgentPolicyScope)}
          options={OWN_AGENT_POLICY_SCOPES.map((value) => ({ value, label: t(`scope_${value}`) }))}
        />
        <Button type="submit" disabled={busy}>
          {t('addRule')}
        </Button>
      </form>
      {refused ? <Refused failed={refused} /> : null}
      {policy.rules.length ? (
        <DataTable label={t('rulesTable')} headers={[t('colEffect'), t('colAction'), t('colScope'), t('colRemove')]}>
          {policy.rules.map((rule) => (
            <tr key={rule.id}>
              <td>{t(`effect_${rule.effect}`)}</td>
              <td>{t(`action_${rule.action}`)}</td>
              <td>{t(`scope_${rule.scope}`)}</td>
              <td>
                <Button type="button" disabled={busy} onClick={() => void send(AGENTS_OWN_POLICY_REMOVE, { ruleId: rule.id })}>
                  {t('remove')}
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="lt-muted">{t('noRules')}</p>
      )}
      {/* The page's reset gives a checkbox no size; the builder's choice class gives it one a person can tick. */}
      <label className="agent-surface-choice" htmlFor={requiredId}>
        <input
          id={requiredId}
          type="checkbox"
          checked={required}
          disabled={busy}
          aria-describedby={`${requiredId}-hint`}
          onChange={(event) => {
            setRequired(event.target.checked);
            void send(AGENTS_OWN_POLICY_REQUIRE, { rulesRequired: event.target.checked });
          }}
        />
        <span>{t('required')}</span>
      </label>
      <p className="lt-muted" id={`${requiredId}-hint`}>
        {t('requiredHint')}
      </p>
      <DataTable label={t('decisionsTable')} headers={[t('colAction'), t('colOutcome')]}>
        {policy.decisions.map((decision) => (
          <tr key={decision.action}>
            <td>{t(`action_${decision.action}`)}</td>
            <td data-testid={`effective-${decision.action.replace('_', '-')}`}>{t(`outcome_${decision.outcome}`)}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}
