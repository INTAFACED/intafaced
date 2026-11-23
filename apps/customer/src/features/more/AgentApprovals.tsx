import { useRef, useState } from 'react';
import { useApi } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import type { Failed } from './AgentGuardrails';
import { agentApprovalsCopy } from './agent-approvals-copy';
import { ownAgentApprovalEditedSchema, type OwnAgentInboxRow } from '@intafaced/contracts/agents-own';
import { AGENTS_OWN_INBOX, AGENTS_OWN_APPROVAL_APPROVE, AGENTS_OWN_APPROVAL_REJECT } from '@intafaced/contracts/agents-own-procedures';

/** Rows shown at once; one more is asked for, so the page can say when older requests are left out. */
export const SHOWN = 100;

export type Done = { readonly words: string; readonly result?: unknown };

/**
 * The Approvals inbox (/agents/approvals, AG-approvals-01): every call of the person's own agents that a rule held for
 * them, across all their agents, newest first, read from svc-agents with its state. A waiting request can be approved
 * (its tool runs once, as the person; approving again shows the first result), edited (a new request for the new input
 * that needs its own approval) or rejected (the agent's step ends with a typed refusal). Every answer is svc-agents':
 * a refusal shows its code, and nothing here moves value. The room that draws it is agent-approvals/AgentApprovalsRoom.tsx.
 */
export function useApprovalsInbox() {
  const api = useApi();
  const { t } = agentApprovalsCopy.useCopy();
  const inbox = useResource((signal) => api.call(AGENTS_OWN_INBOX, { limit: SHOWN + 1 }, { signal }), 'own-inbox');
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
      () => api.call(AGENTS_OWN_APPROVAL_APPROVE, { requestId: row.id }),
      (data) => ({ words: t(data.repeated ? 'approvedAgain' : 'approved'), result: data.request.result }),
    );
  const reject = (row: OwnAgentInboxRow) =>
    decide(
      () => api.call(AGENTS_OWN_APPROVAL_REJECT, { requestId: row.id }),
      () => ({ words: t('rejected') }),
    );
  const edit = (row: OwnAgentInboxRow, input: Record<string, string>) =>
    decide(
      () => api.mutate('agents', 'own.approval.edit', { requestId: row.id, input }, ownAgentApprovalEditedSchema),
      () => ({ words: t('edited') }),
    );

  return { inbox, shown, locked, done, refused, editing, setEditing, approve, reject, edit };
}
