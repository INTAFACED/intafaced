import { useRef, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button, DataTable, Dialog, Field, Panel } from '../../shared/ui';
import { Read } from './common';
import { Answer, requestStateWords, toolWords, type Failed } from './AgentGuardrails';
import { agentGuardrailsCopy } from './agent-guardrails-copy';
import { agentApprovalsCopy, hasApprovalsWords } from './agent-approvals-copy';
import {
  ownAgentApprovalApprovedSchema,
  ownAgentApprovalEditedSchema,
  ownAgentApprovalRequestSchema,
  ownAgentInboxRowSchema,
  type OwnAgentInboxRow,
} from '@intafaced/contracts/agents-own';

const inboxSchema = z.array(ownAgentInboxRowSchema);
/** Rows shown at once; one more is asked for, so the page can say when older requests are left out. */
const SHOWN = 100;

type Done = { readonly words: string; readonly result?: unknown };

/**
 * The Approvals inbox (/agents/approvals, AG-approvals-01): every call of the person's own agents that a rule held for
 * them, across all their agents, newest first, read from svc-agents with its state. A waiting request can be approved
 * (its tool runs once, as the person; approving again shows the first result), edited (a new request for the new input
 * that needs its own approval) or rejected (the agent's step ends with a typed refusal). Every answer is svc-agents':
 * a refusal shows its code, and nothing here moves value.
 */
export function AgentApprovals() {
  const api = useApi();
  const { t } = agentApprovalsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const inbox = useResource((signal) => api.query('agents', 'own.inbox', { limit: SHOWN + 1 }, inboxSchema, { signal }), 'own-inbox');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [refused, setRefused] = useState<Failed | null>(null);
  const [editing, setEditing] = useState<OwnAgentInboxRow | null>(null);
  // After a decision the inbox is read again: the rows last read stay on screen (their buttons off) until it answers,
  // so the page never swaps them for a loading state under the decision's own words. Only rows are kept: a failed read
  // shows its loading state on retry.
  const lastRead = useRef<Extract<Resource<OwnAgentInboxRow[]>, { status: 'ready' }> | null>(null);
  if (inbox.resource.status === 'ready') lastRead.current = inbox.resource;
  else if (inbox.resource.status === 'failed') lastRead.current = null;
  const rereading = inbox.resource.status === 'loading' && lastRead.current !== null;
  const shown = rereading ? lastRead.current! : inbox.resource;
  const locked = busy || rereading;

  async function decide<T>(run: () => Promise<{ ok: true; data: T } | Failed>, words: (data: T) => Done) {
    setBusy(true);
    setDone(null);
    setRefused(null);
    const res = await run();
    setBusy(false);
    inbox.reload();
    if (!res.ok) return setRefused(res);
    setDone(words(res.data));
    setEditing(null);
  }
  const approve = (row: OwnAgentInboxRow) =>
    decide(
      () => api.mutate('agents', 'own.approval.approve', { requestId: row.id }, ownAgentApprovalApprovedSchema),
      (data) => ({ words: t(data.repeated ? 'approvedAgain' : 'approved'), result: data.request.result }),
    );
  const reject = (row: OwnAgentInboxRow) =>
    decide(
      () => api.mutate('agents', 'own.approval.reject', { requestId: row.id }, ownAgentApprovalRequestSchema),
      () => ({ words: t('rejected') }),
    );
  const edit = (row: OwnAgentInboxRow, input: Record<string, string>) =>
    decide(
      () => api.mutate('agents', 'own.approval.edit', { requestId: row.id, input }, ownAgentApprovalEditedSchema),
      () => ({ words: t('edited') }),
    );

  return (
    <Panel title={t('inboxTitle')}>
      <p className="muted">{t('intro')}</p>
      <ServiceOffNotice code="vendor.push" action={t('pushAction')} role="note" />
      {done ? <p role="status">{done.words}</p> : null}
      {done?.result !== undefined && done.result !== null ? (
        <div role="region" aria-label={t('firstResult')}>
          <pre data-testid="first-result">{JSON.stringify(done.result, null, 2)}</pre>
        </div>
      ) : null}
      {refused ? <Answer failed={refused} /> : null}
      <Read resource={shown} retry={inbox.reload}>
        {(rows) => (
          <>
            <DataTable
              label={t('inboxTitle')}
              headers={[
                tools('requestWhen'),
                t('colAgent'),
                tools('requestAction'),
                tools('requestInput'),
                tools('requestState'),
                t('colDecide'),
              ]}
            >
              {rows.slice(0, SHOWN).map((row) => (
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
                  <td>
                    {requestStateWords(tools, row)}
                    {row.refusalCode ? (
                      <>
                        {' '}
                        <code lang="zxx">{row.refusalCode}</code>
                        {row.failureCode ? (
                          <>
                            {' '}
                            <code lang="zxx">{row.failureCode}</code>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </td>
                  <td>
                    {row.status === 'waiting' ? (
                      <>
                        <Button disabled={locked} onClick={() => void approve(row)}>
                          {t('approve')}
                        </Button>
                        <Button variant="secondary" disabled={locked} onClick={() => setEditing(row)}>
                          {t('edit')}
                        </Button>
                        <Button variant="secondary" disabled={locked} onClick={() => void reject(row)}>
                          {t('reject')}
                        </Button>
                      </>
                    ) : null}
                    {row.status === 'approved' ? (
                      <Button variant="secondary" disabled={locked} onClick={() => void approve(row)}>
                        {t('approveAgain')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </DataTable>
            {rows.length > SHOWN ? <p className="muted">{t('more', { shown: String(SHOWN) })}</p> : null}
            {rows.length === 0 ? <p className="muted">{t('empty')}</p> : null}
          </>
        )}
      </Read>
      {editing ? (
        <EditRequest row={editing} busy={locked} onSave={(input) => void edit(editing, input)} onClose={() => setEditing(null)} />
      ) : null}
    </Panel>
  );
}

/** The request's input, one field per field it holds; saving makes a new request for it, which waits for approval. */
function EditRequest({
  row,
  busy,
  onSave,
  onClose,
}: {
  row: OwnAgentInboxRow;
  busy: boolean;
  onSave: (input: Record<string, string>) => void;
  onClose: () => void;
}) {
  const { t } = agentApprovalsCopy.useCopy();
  const [input, setInput] = useState<Record<string, string>>({ ...row.input });
  const label = (field: string) => {
    const key = `field_${field}`;
    return hasApprovalsWords(key) ? t(key) : field;
  };
  return (
    <Dialog title={t('editTitle')} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(input);
        }}
      >
        <p className="muted">{t('editIntro')}</p>
        {Object.keys(row.input).map((field) => (
          <Field
            key={field}
            name={field}
            label={label(field)}
            value={input[field] ?? ''}
            onChange={(event) => setInput((current) => ({ ...current, [field]: event.target.value }))}
          />
        ))}
        <Button type="submit" disabled={busy}>
          {t('saveEdit')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
      </form>
    </Dialog>
  );
}
