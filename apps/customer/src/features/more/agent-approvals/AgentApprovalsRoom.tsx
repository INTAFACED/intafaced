// volt-room: /agents/approvals
import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { RecordListTemplate, Sheet } from '@intafaced/ui/lit/templates';
import type { OwnAgentInboxRow } from '@intafaced/contracts/agents-own';
import { FailureBox, ReadView } from '../../../shared/record/record-parts';
import { ServiceOffNotice } from '../../../shared/service-off';
import { SHOWN, useApprovalsInbox } from '../AgentApprovals';
import { refusalWords, requestStateWords, toolWords, type Failed } from '../AgentGuardrails';
import { agentGuardrailsCopy } from '../agent-guardrails-copy';
import { agentApprovalsCopy, hasApprovalsWords } from '../agent-approvals-copy';

/**
 * The Approvals inbox (/agents/approvals, AG-approvals-01) on the record-list template: every call of the person's own
 * agents that a rule held for them, newest first, with Approve, Edit and Reject. The reads and decisions are
 * `useApprovalsInbox` (AgentApprovals.tsx); this file only draws them.
 */
export function AgentApprovalsRoom() {
  const { t } = agentApprovalsCopy.useCopy();
  const tools = agentGuardrailsCopy.useCopy().t;
  const { inbox, shown, locked, done, refused, editing, setEditing, approve, reject, edit } = useApprovalsInbox();
  return (
    <RecordListTemplate
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      list={
        <section>
          <h2>{t('inboxTitle')}</h2>
          <p className="lt-hint">{t('intro')}</p>
          <ServiceOffNotice code="vendor.push" action={t('pushAction')} role="note" />
          {done ? <p role="status">{done.words}</p> : null}
          {done?.result !== undefined && done.result !== null ? (
            <div role="region" aria-label={t('firstResult')}>
              <pre data-testid="first-result">{JSON.stringify(done.result, null, 2)}</pre>
            </div>
          ) : null}
          {refused ? <AnswerLine failed={refused} /> : null}
          <ReadView resource={shown} retry={inbox.reload}>
            {(rows) => (
              <>
                <div tabIndex={0} role="region" aria-label={t('inboxTitle')}>
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th scope="col">{tools('requestWhen')}</th>
                        <th scope="col">{t('colAgent')}</th>
                        <th scope="col">{tools('requestAction')}</th>
                        <th scope="col">{tools('requestInput')}</th>
                        <th scope="col">{tools('requestState')}</th>
                        <th scope="col">{t('colDecide')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, SHOWN).map((row) => (
                        <tr key={row.id} data-request-id={row.id}>
                          <td>{new Date(row.createdAt).toLocaleString()}</td>
                          <td>
                            <a className="lt-link" href={`/agents/${row.agentId}`}>
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
                              <div className="lt-actions">
                                <Button tone="primary" disabled={locked} onClick={() => void approve(row)}>
                                  {t('approve')}
                                </Button>
                                <Button disabled={locked} onClick={() => setEditing(row)}>
                                  {t('edit')}
                                </Button>
                                <Button disabled={locked} onClick={() => void reject(row)}>
                                  {t('reject')}
                                </Button>
                              </div>
                            ) : null}
                            {row.status === 'approved' ? (
                              <Button disabled={locked} onClick={() => void approve(row)}>
                                {t('approveAgain')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > SHOWN ? <p className="lt-hint">{t('more', { shown: String(SHOWN) })}</p> : null}
                {rows.length === 0 ? <p className="lt-hint">{t('empty')}</p> : null}
              </>
            )}
          </ReadView>
          {editing ? (
            <EditRequest row={editing} busy={locked} onSave={(input) => void edit(editing, input)} onClose={() => setEditing(null)} />
          ) : null}
        </section>
      }
    />
  );
}

/** A refusal as words with its code beside them, or the app's own account of a failure that is not one. */
function AnswerLine({ failed }: { failed: Failed }) {
  const { t } = agentGuardrailsCopy.useCopy();
  const refusal = refusalWords(t, failed);
  if (!refusal) return <FailureBox result={failed} />;
  return (
    <p role="alert">
      {refusal.words} <code lang="zxx">{refusal.code}</code>
    </p>
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
    <Sheet open title={t('editTitle')} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(input);
        }}
      >
        <p className="lt-hint">{t('editIntro')}</p>
        {Object.keys(row.input).map((field) => (
          <Field
            key={field}
            name={field}
            label={label(field)}
            value={input[field] ?? ''}
            onChange={(event) => setInput((current) => ({ ...current, [field]: event.target.value }))}
          />
        ))}
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={busy}>
            {t('saveEdit')}
          </Button>
          <Button onClick={onClose}>{t('cancel')}</Button>
        </div>
      </form>
    </Sheet>
  );
}
