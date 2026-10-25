'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Field,
  Input,
  KeyValue,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import type { ActionApproval } from '@intafaced/contracts';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import {
  trialText,
  VIP_STATUS_TEXT,
  type VipApplication,
  type VipDecision,
  type VipEvent,
  type VipList,
  type VipProofFile,
  type VipStatus,
  type VipTrialRules,
} from '@/lib/trade-ops/vip-review';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * Compliance decides VIP applications (SP-fees-vip-04): read the list, open one, open its proof for a stated reason
 * (audited), then decide with a second founder: (1) ask for the approval, bound to the decision, the reason and the
 * trial the owner publishes now; (2) a different founder approves it in the Freezes & approvals room; (3) apply it with
 * the approval id. An application approved while no trial is published reads "approved, no trial period set", and its
 * trial is granted the same way once the owner publishes one. Nothing here invents a tier or a length.
 */

type Filter = VipStatus | 'all';
const FILTERS: Record<Filter, string> = {
  pending: 'Waiting for review',
  approved_no_trial: 'Approved, no trial set',
  approved: 'Approved',
  rejected: 'Not approved',
  all: 'All',
};

const utc = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

interface Proposed {
  readonly approval: ActionApproval;
  readonly payloadHash: string;
  readonly trial: VipTrialRules | null;
}

export function VipApplications({ initial, initialFilter }: { initial: Outcome<VipList>; initialFilter: Filter }) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [read, setRead] = useState<Outcome<VipList>>(initial);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = read.kind === 'ok' ? read.data : null;
  const open = list?.applications.find((a) => a.id === openId) ?? null;

  async function load(next: Filter = filter) {
    setBusy(true);
    setRead(await tradeOpsAction<VipList>('vip-applications', { action: 'read', status: next === 'all' ? null : next }));
    setBusy(false);
  }

  const columns: TableColumn<VipApplication>[] = [
    { id: 'at', header: 'Sent (UTC)', width: 170, value: (a) => utc(a.createdAt) },
    { id: 'user', header: 'Account', value: (a) => a.userId, cell: (a) => <span className="if-num text-xs">{a.userId}</span> },
    { id: 'file', header: 'Proof', value: (a) => `${a.proof.fileName} · ${a.proof.contentType} · ${kb(a.proof.byteLength)}` },
    { id: 'note', header: 'Note', value: (a) => a.note ?? '—' },
    {
      id: 'status',
      header: 'Status',
      width: 200,
      value: (a) => VIP_STATUS_TEXT[a.status],
      cell: (a) => (
        <Badge tone={a.status === 'pending' ? 'warn' : a.status === 'rejected' ? 'neutral' : 'lime'} variant="outline" density="dense">
          {VIP_STATUS_TEXT[a.status]}
        </Badge>
      ),
    },
    {
      id: 'trial',
      header: 'Trial',
      width: 220,
      value: (a) => (a.trial ? `${a.trial.tierId} until ${utc(a.trial.endsAt)}` : '—'),
    },
    {
      id: 'open',
      header: '',
      width: 90,
      value: () => null,
      cell: (a) => (
        <Button size={28} variant="ghost" shape="rounded" onClick={() => setOpenId(a.id)} aria-pressed={openId === a.id}>
          Open
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-room="vip-applications">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show" density="dense">
          <Select
            items={FILTERS}
            value={filter}
            onValueChange={(v) => {
              const next = String(v) as Filter;
              setFilter(next);
              setOpenId(null);
              void load(next);
            }}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <SelectItem key={f} value={f}>
                  {FILTERS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button size={32} variant="secondary" shape="rounded" loading={busy} onClick={() => void load()}>
          Read again
        </Button>
      </div>
      {read.kind !== 'ok' ? <OutcomeNotice outcome={read} /> : null}
      {list ? (
        <KeyValue
          density="dense"
          items={[
            { label: 'An approval grants now', value: trialText(list.trialRules) },
            {
              label: 'Proof files',
              value: list.proofKeyed
                ? 'Open with a stated reason; each opening is audited.'
                : 'Cannot be opened: the proof file key is not set (vip.proof_key_unset).',
            },
          ]}
        />
      ) : null}
      {list ? (
        list.applications.length === 0 ? (
          <p className="text-sm text-fg-2" data-vip-desk="none">
            No applications in this view.
          </p>
        ) : (
          <Table<VipApplication>
            label="VIP applications"
            density="dense"
            columns={columns}
            rows={list.applications}
            getRowId={(a) => a.id}
          />
        )
      ) : null}
      {open && list ? <VipApplicationPanel key={open.id} application={open} list={list} onChanged={() => void load()} /> : null}
    </div>
  );
}

function VipApplicationPanel({ application, list, onChanged }: { application: VipApplication; list: VipList; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<VipDecision>('approve');
  const [busy, setBusy] = useState(false);
  // Only the outcome's words are kept: the file's bytes go to the download and are dropped here.
  const [proof, setProof] = useState<Outcome<{ fileName: string }> | null>(null);
  const [check, setCheck] = useState<Outcome<{ payloadHash: string; trial: VipTrialRules | null }> | null>(null);
  const [proposed, setProposed] = useState<Outcome<Proposed> | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const reasonOk = reason.trim().length >= 12 && reason.trim().length <= 500;
  const kind: 'review' | 'grant' | null =
    application.status === 'pending' ? 'review' : application.status === 'approved_no_trial' ? 'grant' : null;
  const grantBlocked = kind === 'grant' && list.trialRules === null;

  async function openProof() {
    setBusy(true);
    const out = await tradeOpsAction<VipProofFile>('vip-applications', { action: 'proof', applicationId: application.id, reason });
    if (out.kind === 'ok') setProof({ ...out, data: { fileName: save(out.data) } });
    else setProof(out);
    setBusy(false);
  }

  async function workOutHash() {
    setBusy(true);
    setCheck(
      await tradeOpsAction('vip-applications', {
        action: 'hash',
        kind,
        applicationId: application.id,
        ...(kind === 'review' ? { decision } : {}),
        reason,
      }),
    );
    setBusy(false);
  }

  async function propose() {
    setBusy(true);
    setProposed(
      await tradeOpsAction<Proposed>('vip-applications', {
        action: 'propose',
        kind,
        applicationId: application.id,
        ...(kind === 'review' ? { decision } : {}),
        reason,
      }),
    );
    setBusy(false);
  }

  const eventColumns: TableColumn<VipEvent & { readonly n: number }>[] = [
    { id: 'at', header: 'When (UTC)', width: 170, value: (e) => utc(e.at) },
    { id: 'status', header: 'Status', width: 200, value: (e) => VIP_STATUS_TEXT[e.status] },
    {
      id: 'who',
      header: 'By',
      value: (e) => (e.approverId ? `${e.actorId} → approved by ${e.approverId}` : `${e.actorId} (${e.actorRole})`),
    },
    { id: 'reason', header: 'Reason', value: (e) => e.reason ?? '—' },
  ];

  const consequence =
    kind === 'review'
      ? decision === 'reject'
        ? 'The application is marked not approved. The person sees it on My tier and may apply again.'
        : list.trialRules
          ? `The application is approved and the person is on ${trialText(list.trialRules)}, from now. The approval is used up.`
          : 'The application is approved with no trial period, since none is published (vip.trial_unset). A trial can be granted once the owner publishes one.'
      : `The person is granted ${trialText(list.trialRules)}, from now. The approval is used up.`;

  return (
    <section className="flex flex-col gap-3 rounded border border-line p-4" aria-label="Application" data-vip-desk="open">
      <h3 className="text-sm font-medium text-fg-1">Application {application.id}</h3>
      <KeyValue
        density="dense"
        items={[
          { label: 'Account', value: application.userId, mono: true },
          { label: 'Status', value: VIP_STATUS_TEXT[application.status] },
          {
            label: 'Proof',
            value: `${application.proof.fileName} (${application.proof.contentType}, ${kb(application.proof.byteLength)})`,
          },
          { label: 'SHA-256', value: application.proof.sha256, mono: true },
          { label: 'Note from the person', value: application.note ?? '—' },
          {
            label: 'Trial',
            value: application.trial
              ? `${application.trial.tierId}, ${application.trial.days} days, ${utc(application.trial.startsAt)} to ${utc(application.trial.endsAt)} UTC`
              : '—',
          },
        ]}
      />
      <Table<VipEvent & { readonly n: number }>
        label="History"
        density="dense"
        columns={eventColumns}
        rows={application.events.map((e, n) => ({ ...e, n }))}
        getRowId={(e) => String(e.n)}
      />
      <Field label="Reason (12 to 500 characters, kept in the audit and bound to the approval)" density="dense">
        <Input
          value={reason}
          onValueChange={(v) => {
            setReason(v);
            setCheck(null);
          }}
          density="dense"
          autoComplete="off"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size={32}
          variant="secondary"
          shape="rounded"
          loading={busy}
          disabled={!reasonOk || !list.proofKeyed}
          onClick={() => void openProof()}
        >
          Save the proof file
        </Button>
        {!list.proofKeyed ? <span className="text-sm text-fg-2">The proof file key is not set, so no proof opens.</span> : null}
      </div>
      {proof && proof.kind !== 'ok' ? <OutcomeNotice outcome={proof} /> : null}
      {proof?.kind === 'ok' ? <p className="text-sm text-fg-2">Saved {proof.data.fileName}. The opening is in the audit.</p> : null}

      {kind === null ? (
        <p className="text-sm text-fg-2">
          This application is decided{application.trial ? ' and its trial granted' : ''}: nothing is left to do.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {kind === 'review' ? (
            <Field label="Decision" density="dense">
              <Select
                items={{ approve: 'Approve', reject: 'Reject' }}
                value={decision}
                onValueChange={(v) => {
                  setDecision(String(v) as VipDecision);
                  setProposed(null);
                  setCheck(null);
                }}
              >
                <SelectTrigger size={32}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="approve">Approve</SelectItem>
                  <SelectItem value="reject">Reject</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-fg-2">
              {grantBlocked
                ? 'No trial can be granted: the owner has not published one (tier and days). vip.trial_unset'
                : `Grant the trial the owner publishes now: ${trialText(list.trialRules)}.`}
            </p>
          )}
          <div>
            <Button
              size={32}
              variant="primary"
              shape="rounded"
              loading={busy}
              disabled={!reasonOk || grantBlocked}
              onClick={() => void propose()}
            >
              Ask a second founder to approve
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size={32}
              variant="secondary"
              shape="rounded"
              loading={busy}
              disabled={!reasonOk || grantBlocked}
              onClick={() => void workOutHash()}
            >
              Work out the hash to check
            </Button>
            <span className="text-sm text-fg-2">
              Approving a request another founder filed? Enter the decision and reason they gave you: the hash must match the
              request&apos;s.
            </span>
          </div>
          {check && check.kind !== 'ok' ? <OutcomeNotice outcome={check} /> : null}
          {check?.kind === 'ok' ? (
            <KeyValue
              density="dense"
              data-vip-desk="check"
              items={[
                { label: 'Hash of exactly this', value: check.data.payloadHash, mono: true },
                { label: 'It grants', value: check.data.trial ? trialText(check.data.trial) : 'No trial' },
              ]}
            />
          ) : null}
          {proposed ? <OutcomeNotice outcome={proposed} doneText="Request filed" /> : null}
          {proposed?.kind === 'ok' ? (
            <KeyValue
              density="dense"
              items={[
                { label: 'Approval id (apply with this once approved)', value: proposed.data.approval.approvalId, mono: true },
                { label: 'Payload hash (the approver confirms this)', value: proposed.data.payloadHash, mono: true },
                { label: 'Bound to', value: `${application.status}; trial: ${trialText(proposed.data.trial)}` },
              ]}
            />
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Approved request id" density="dense">
              <Input value={approvalId} onValueChange={setApprovalId} density="dense" autoComplete="off" spellCheck={false} />
            </Field>
            <ConfirmAction
              trigger={kind === 'review' ? 'Apply the approved decision' : 'Grant the approved trial'}
              title={kind === 'review' ? `${decision === 'approve' ? 'Approve' : 'Reject'} this application?` : 'Grant the trial?'}
              consequence={consequence}
              confirmLabel={kind === 'review' ? 'Apply decision' : 'Grant trial'}
              reasonMin={0}
              disabled={!reasonOk || approvalId.trim() === '' || grantBlocked}
              disabledReason={grantBlocked ? 'No trial is published.' : 'Enter the reason and the approved request id.'}
              run={() =>
                tradeOpsAction('vip-applications', {
                  action: 'apply',
                  kind,
                  applicationId: application.id,
                  ...(kind === 'review' ? { decision } : {}),
                  reason,
                  approvalId: approvalId.trim(),
                })
              }
              onDone={(o) => {
                if (o.kind === 'ok') onChanged();
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/** The extension the checked type gets: the saved name never claims a type the bytes were not checked as. */
const EXTENSION: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

/** Hand the file to the browser as a download: never opened or rendered in the console. Returns the name it was saved as. */
function save(file: VipProofFile): string {
  const ext = EXTENSION[file.contentType] ?? '.bin';
  const base = file.fileName.replace(/\.[^.]*$/, '') || 'proof';
  const name = `${base}${ext}`;
  const bytes = Uint8Array.from(atob(file.bytesBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for every browser to start the download from the URL; revoking at once cancels it in some.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
