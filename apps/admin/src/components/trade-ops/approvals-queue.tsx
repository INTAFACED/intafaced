'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, SegmentedControl, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  isPayloadHash,
  knownRequester,
  sameOperator,
  wordsForApprovalCode,
  type ApprovalLogEntry,
  type ApprovalVerb,
} from '@/lib/trade-ops/approvals';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { ActionApproval } from '@intafaced/contracts';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';
import { recordApproval, useApprovalLog } from './approvals-log';

const VERB_LABEL = { propose: 'Propose', approve: 'Approve', reject: 'Reject', revoke: 'Revoke' } as const;

/**
 * Panel (c): the approval queue. Identity lists the approvals this operator may decide (`actionApproval.list`, view
 * `pending`); picking one fills in its id and hash, and the operator can still act on an id the proposer handed over.
 * Approve / reject / revoke are real calls. The requester can never approve or reject their own request:
 * this form refuses it first (when it knows who proposed it) and the service refuses it again.
 */
export function ApprovalsQueue({ sessionUserId }: { sessionUserId: string }) {
  const log = useApprovalLog();
  const [verb, setVerb] = useState<ApprovalVerb>('approve');
  const [approvalId, setApprovalId] = useState('');
  const [hash, setHash] = useState('');
  const [requesterTyped, setRequesterTyped] = useState('');
  const id = approvalId.trim();
  const known = knownRequester(log, id) ?? (requesterTyped.trim() || undefined);
  const selfBlocked = verb !== 'revoke' && sameOperator(known, sessionUserId);
  const hashBad = verb === 'approve' && !!hash.trim() && !isPayloadHash(hash.trim());
  const ready = !!id && !selfBlocked && (verb !== 'approve' || isPayloadHash(hash.trim()));

  async function run(): Promise<Outcome<unknown>> {
    const out = await tradeOpsAction<ActionApproval>('approvals', {
      action: verb,
      approvalId: id,
      ...(verb === 'approve' ? { expectedPayloadHash: hash.trim() } : {}),
      ...(known ? { knownRequesterId: known } : {}),
    });
    recordApproval({
      at: out.asOf,
      actorUserId: sessionUserId,
      verb,
      approvalId: id,
      actionType: out.kind === 'ok' ? out.data.actionType : null,
      targetId: out.kind === 'ok' ? out.data.targetId : null,
      requesterId: out.kind === 'ok' ? out.data.requesterId : (known ?? null),
      reason: null,
      outcome: out.kind === 'ok' ? 'ok' : out.kind,
      result: out.kind === 'ok' ? out.data.status : out.kind === 'refused' ? out.code : '',
    });
    return out;
  }

  const verbWords: Record<ApprovalVerb, { label: string; does: string }> = {
    approve: {
      label: 'Approve',
      does: 'Approving says you reviewed exactly the change with this hash. It still does not apply the restriction.',
    },
    reject: { label: 'Reject', does: 'Rejecting closes the request for good. The proposer must start a new one.' },
    revoke: { label: 'Revoke', does: 'Revoking withdraws a request you proposed. Only the proposer can do it.' },
  };

  const columns: TableColumn<ApprovalLogEntry>[] = useMemo(
    () => [
      { id: 'at', header: 'Time (UTC)', value: (r) => r.at.replace('T', ' ').slice(0, 19), width: 160 },
      { id: 'verb', header: 'You did', value: (r) => VERB_LABEL[r.verb], width: 90 },
      { id: 'id', header: 'Approval id', value: (r) => r.approvalId },
      {
        id: 'outcome',
        header: 'Result',
        cell: (r) => (
          <span className="flex items-center gap-2">
            <Badge tone={r.outcome === 'ok' ? 'lime' : r.outcome === 'unknown' ? 'warn' : 'error'} density="dense">
              {r.outcome === 'ok' ? 'Confirmed' : r.outcome === 'unknown' ? 'Unknown' : 'Refused'}
            </Badge>
            <span className="if-num text-xs text-fg-2">{r.result}</span>
          </span>
        ),
        value: (r) => `${r.outcome} ${r.result}`,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <PendingList
        onPick={(a) => {
          setApprovalId(a.approvalId);
          setHash(a.payloadHash);
          setRequesterTyped(a.requesterId);
        }}
      />
      <p className="text-sm text-fg-2">
        Act on an approval by its id. You are signed in as <code className="if-num text-xs">{sessionUserId}</code>; you cannot approve or
        reject a request you proposed yourself.
      </p>
      <div className="flex flex-col gap-3">
        <SegmentedControl
          aria-label="Approval action"
          size={32}
          value={verb}
          onValueChange={(v) => setVerb(v === 'reject' ? 'reject' : v === 'revoke' ? 'revoke' : 'approve')}
          items={[
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'revoke', label: 'Revoke' },
          ]}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Approval id" hint="From the proposer." density="dense">
            <Input value={approvalId} onValueChange={setApprovalId} density="dense" autoComplete="off" spellCheck={false} />
          </Field>
          {verb === 'approve' ? (
            <Field
              label="Payload hash you reviewed"
              hint="sha256: and 64 hex characters, shown when the request was created."
              error={hashBad ? 'Not a valid payload hash.' : undefined}
              density="dense"
            >
              <Input value={hash} onValueChange={setHash} density="dense" autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
          {verb !== 'revoke' && !knownRequester(log, id) ? (
            <Field
              label="Proposer's user id (optional)"
              hint="If you know who proposed it, enter it so this desk can refuse a same-person approval before sending."
              density="dense"
            >
              <Input value={requesterTyped} onValueChange={setRequesterTyped} density="dense" autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
        </div>
        {verb === 'approve' ? <HashHelper onHash={setHash} /> : null}
        {selfBlocked ? (
          <p role="alert" className="text-sm text-warn">
            {wordsForApprovalCode('action_approval.same_person')} (action_approval.same_person)
          </p>
        ) : null}
        <div>
          <ConfirmAction
            trigger={`${verbWords[verb].label} request`}
            title={`${verbWords[verb].label} request ${id || ''}`.trim()}
            consequence={verbWords[verb].does}
            confirmLabel={verbWords[verb].label}
            reasonMin={0}
            tone={verb === 'approve' ? 'default' : 'danger'}
            triggerVariant={verb === 'approve' ? 'primary' : undefined}
            disabled={!ready}
            disabledReason={
              selfBlocked
                ? 'You proposed this request; a different operator must decide it.'
                : 'Enter the approval id (and the payload hash to approve).'
            }
            run={run}
          />
        </div>
        <ApprovalResultHelp />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
          Your approval actions <Badge density="dense">This session only</Badge>
        </h3>
        <p className="text-xs text-fg-3">
          Kept in this browser tab until you close it. It is not the service's record and other operators' actions are not here.
        </p>
        <Table
          label="Approval actions in this session"
          density="dense"
          columns={columns}
          rows={log}
          getRowId={(r) => `${r.at}-${r.verb}-${r.approvalId ?? ''}`}
          maxHeight={240}
          emptyState={<p className="p-4 text-sm text-fg-2">Nothing yet this session.</p>}
        />
      </div>
    </div>
  );
}

function ApprovalResultHelp() {
  return (
    <details className="text-xs text-fg-3">
      <summary className="cursor-pointer text-fg-2">What the service's refusals mean</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {[
          'action_approval.same_person',
          'action_approval.payload_mismatch',
          'action_approval.expired',
          'action_approval.not_pending',
          'action_approval.not_found',
          'action_approval.not_requester',
        ].map((c) => (
          <li key={c}>
            <code className="if-num">{c}</code>: {wordsForApprovalCode(c)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Works out the payload hash from the change details, the same way the proposal was hashed. */
function HashHelper({ onHash }: { onHash: (hash: string) => void }) {
  const [userId, setUserId] = useState('');
  const [change, setChange] = useState<'restrict' | 'restore'>('restrict');
  const [reason, setReason] = useState('');
  const [version, setVersion] = useState('');
  const [result, setResult] = useState<Outcome<{ payloadHash: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  async function work() {
    setBusy(true);
    const out = await tradeOpsAction<{ payloadHash: string }>('approvals', {
      action: 'hash',
      userId,
      change,
      reason,
      expectedVersion: version,
    });
    setBusy(false);
    setResult(out);
    if (out.kind === 'ok') onHash(out.data.payloadHash);
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-fg-2">Work out the hash from the change I was shown</summary>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <Field label="Account user id" density="dense">
          <Input value={userId} onValueChange={setUserId} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Expected version" density="dense">
          <Input value={version} onValueChange={setVersion} density="dense" autoComplete="off" />
        </Field>
        <Field label="Reason, exactly as proposed" density="dense">
          <Input value={reason} onValueChange={setReason} density="dense" autoComplete="off" />
        </Field>
        <SegmentedControl
          aria-label="Restrict or lift in the proposal"
          size={32}
          value={change}
          onValueChange={(v) => setChange(v === 'restore' ? 'restore' : 'restrict')}
          items={[
            { value: 'restrict', label: 'Restrict' },
            { value: 'restore', label: 'Lift' },
          ]}
        />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button type="button" size={28} variant="secondary" shape="rounded" loading={busy} onClick={work}>
          Fill in the hash
        </Button>
        {result && result.kind !== 'ok' ? <OutcomeNotice outcome={result} /> : null}
        {result?.kind === 'ok' ? <span className="if-num text-xs text-fg-2">{result.data.payloadHash}</span> : null}
      </div>
    </details>
  );
}

/** Approvals waiting for this operator, straight from identity. A failed read says so; it never shows an empty queue. */
function PendingList({ onPick }: { onPick: (a: ActionApproval) => void }) {
  const [out, setOut] = useState<Outcome<{ approvals: readonly ActionApproval[]; pageFull: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setOut(await tradeOpsAction('approvals', { action: 'list', view: 'pending' }));
    setBusy(false);
  }
  useEffect(() => {
    void load();
  }, []);
  const columns: TableColumn<ActionApproval>[] = [
    { id: 'action', header: 'Action', value: (a) => a.actionType, width: 180 },
    { id: 'target', header: 'Target', value: (a) => a.targetId },
    { id: 'by', header: 'Proposed by', value: (a) => a.requesterId },
    { id: 'status', header: 'Status', value: (a) => a.status, width: 110 },
  ];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
        Waiting for a decision
        <Button type="button" size={28} variant="secondary" shape="rounded" loading={busy} onClick={load}>
          Refresh
        </Button>
      </h3>
      {out && out.kind !== 'ok' ? <OutcomeNotice outcome={out} /> : null}
      {out?.kind === 'ok' ? (
        <>
          {out.data.pageFull ? <p className="text-xs text-warn">Only the first 50 are listed; more may be waiting.</p> : null}
          <Table
            label="Approvals waiting for this operator"
            density="dense"
            columns={columns}
            rows={out.data.approvals}
            getRowId={(a) => a.approvalId}
            maxHeight={240}
            onRowActivate={onPick}
            emptyState={<p className="p-4 text-sm text-fg-2">Identity lists nothing waiting for you.</p>}
          />
          <p className="text-xs text-fg-3">
            Pick a row to fill in its id and hash. You still check the hash against what the proposer showed you.
          </p>
        </>
      ) : null}
    </div>
  );
}
