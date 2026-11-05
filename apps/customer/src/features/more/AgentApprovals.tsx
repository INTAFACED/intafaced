import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, DataTable, Panel } from '../../shared/ui';
import { Read } from './common';
import { toolWords } from './AgentGuardrails';
import { agentGuardrailsCopy } from './agent-guardrails-copy';
import { agentApprovalsCopy } from './agent-approvals-copy';
import { ownAgentInboxRowSchema } from '@intafaced/contracts/agents-own';

const inboxSchema = z.array(ownAgentInboxRowSchema);

/**
 * The Approvals inbox (/agents/approvals, AG-approvals-01): every call of the person's own agents that a rule holds for
 * them, across all their agents, newest first, read from svc-agents. None of them has run. Approve, Edit and Reject are
 * shown and off, with the reason, until deciding a request is built: nothing here runs a tool or moves value.
 */
export function AgentApprovals() {
  const api = useApi();
  const { t } = agentApprovalsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const inbox = useResource((signal) => api.query('agents', 'own.inbox', { limit: 100 }, inboxSchema, { signal }), 'own-inbox');
  return (
    <Panel title={t('inboxTitle')}>
      <p className="muted">{t('intro')}</p>
      <p role="note">{t('decideParked')}</p>
      <Read resource={inbox.resource} retry={inbox.reload}>
        {(rows) => (
          <>
            <DataTable
              label={t('inboxTitle')}
              headers={[t('colWhen'), t('colAgent'), t('colAction'), t('colInput'), t('colState'), t('colDecide')]}
            >
              {rows.map((row) => (
                <tr key={row.id} data-request-id={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>
                    <a className="text-link" href={`/agents/${row.agentId}`}>
                      {row.agentName}
                    </a>
                  </td>
                  <td>{toolWords(tools, row.tool)}</td>
                  <td>
                    {Object.entries(row.input)
                      .map(([field, value]) => `${field}: ${value}`)
                      .join('; ')}
                  </td>
                  <td>{tools(`request_${row.status}`)}</td>
                  <td>
                    <Button disabled>{t('approve')}</Button>
                    <Button variant="secondary" disabled>
                      {t('edit')}
                    </Button>
                    <Button variant="secondary" disabled>
                      {t('reject')}
                    </Button>
                  </td>
                </tr>
              ))}
            </DataTable>
            {rows.length === 0 ? <p className="muted">{t('empty')}</p> : null}
          </>
        )}
      </Read>
    </Panel>
  );
}
