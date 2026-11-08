import { useId, useState } from 'react';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Failure, Panel } from '../../shared/ui';
import { Read, Select } from './common';
import { agentAccessCopy } from './agent-access-copy';
import type { Failed } from './AgentGuardrails';
import {
  OWN_AGENT_POLICY_ACTIONS,
  OWN_AGENT_POLICY_EFFECTS,
  OWN_AGENT_POLICY_SCOPES,
  ownAgentPolicySchema,
  type OwnAgent,
  type OwnAgentPolicy,
  type OwnAgentPolicyAction,
  type OwnAgentPolicyEffect,
  type OwnAgentPolicyScope,
} from '@intafaced/contracts/agents-own';

/**
 * An own agent's Access page (AG-spend-02, J-agents-08 #1): the person's allow and deny rules by action and account, and
 * what svc-agents decides from them for each action on the main account. Every decision shown is the service's own; the
 * page never works one out. Nothing here moves money.
 */

const KNOWN = new Set(['agents.policy_rule_not_found', 'agents.own.not_found']);

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
  const loaded = useResource(
    (signal) => api.query('agents', 'own.policy.get', { id: agent.id }, ownAgentPolicySchema, { signal }),
    `own-policy:${agent.id}`,
  );
  return (
    <Panel title={t('accessTitle')} role="region" aria-label={t('accessTitle')}>
      <Read resource={loaded.resource} retry={loaded.reload}>
        {(policy) => <Policy agent={agent} stored={policy} />}
      </Read>
    </Panel>
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
  async function send(procedure: string, input: Record<string, unknown>) {
    setBusy(true);
    setRefused(null);
    const res = await api.mutate('agents', procedure, { id: agent.id, ...input }, ownAgentPolicySchema);
    setBusy(false);
    if (!res.ok) return setRefused(res);
    setPolicy(res.data);
  }
  return (
    <>
      <p className="muted">{t('accessIntro')}</p>
      <form
        aria-label={t('newRule')}
        onSubmit={(event) => {
          event.preventDefault();
          void send('own.policy.add', { effect, action, scope });
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
                <Button type="button" disabled={busy} onClick={() => void send('own.policy.remove', { ruleId: rule.id })}>
                  {t('remove')}
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="muted">{t('noRules')}</p>
      )}
      <label htmlFor={requiredId}>
        <input
          id={requiredId}
          type="checkbox"
          checked={policy.rulesRequired}
          disabled={busy}
          aria-describedby={`${requiredId}-hint`}
          onChange={(event) => void send('own.policy.require', { rulesRequired: event.target.checked })}
        />
        <span>{t('required')}</span>
      </label>
      <p className="muted" id={`${requiredId}-hint`}>
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
