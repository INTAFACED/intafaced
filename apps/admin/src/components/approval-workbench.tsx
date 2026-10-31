'use client';

import { useId, useRef, useState } from 'react';
import { KycDocumentViewer } from '@/components/kyc-document-viewer';
import { formatWhen } from '@/lib/as-of';
import { postStep, type ApprovalEndpoint } from '@/lib/desk/approval-browser';
import {
  confirmPhrase,
  decodePacket,
  describeRequest,
  needsStepUp,
  requestReason,
  type ApprovalPacket,
  type PacketReading,
} from '@/lib/desk/approval-packet';
import type { StepName, StepReply } from '@/lib/desk/approval-types';
import { describePacketStatus, roleFor, shortId, stepGate } from '@/lib/desk/desk-model';
import './desk.css';

/**
 * WORK ON A TWO-FOUNDER REQUEST.
 *
 * Paste the request packet the first founder sent (or the one this console just made), read what it will do in plain
 * words, type the phrase, and approve, reject, withdraw or run it. Identity decides who may do what and spends the
 * approval once; this screen only makes the step unmistakable and shows what each service answered.
 */

const OK_TEXT: Record<Exclude<StepName, 'execute'>, string> = {
  propose: 'Request made. Nothing has run. It waits for a different founder to approve it.',
  approve: 'Approved. The request can now be run. Nothing has run yet.',
  reject: 'Rejected. This request can no longer be used.',
  revoke: 'Withdrawn. This request can no longer be used.',
};

/** What a closed document leaves on the page: words only, its contents dropped from the reply. */
export const DOCUMENT_CLOSED_REPLY: StepReply = {
  ok: true,
  step: 'execute',
  detail: 'Document closed. Its contents are no longer on this page; opening it again needs a new approval.',
};

export function StepReplyView({ reply, onCloseDocument }: { reply: StepReply; onCloseDocument?: () => void }) {
  if (reply.ok) {
    if (reply.step === 'execute') {
      return (
        <div className="adm-callout" role="status" data-testid="step-reply" data-tone="ok">
          <strong>The service answered</strong>
          <p>{reply.detail}</p>
          {reply.document ? (
            <KycDocumentViewer document={reply.document} onClose={onCloseDocument} />
          ) : (
            <p className="dk-muted">
              This is what the service said. The state shown above is read again from the service, not taken from this message.
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="adm-callout" role="status" data-testid="step-reply" data-tone="ok">
        <strong>{OK_TEXT[reply.step]}</strong>
        <dl className="dk-kv">
          <dt>Approval</dt>
          <dd className="dk-packet">{reply.approval.approvalId}</dd>
          <dt>Status at identity</dt>
          <dd>{reply.approval.status}</dd>
          <dt>Requested by</dt>
          <dd className="dk-packet">{shortId(reply.approval.requesterId)}</dd>
          <dt>Approved by</dt>
          <dd className="dk-packet">{shortId(reply.approval.approverId)}</dd>
          <dt>Expires</dt>
          <dd>{formatWhen(reply.approval.expiresAt)}</dd>
        </dl>
        {reply.matchesReviewedRequest === false && (
          <p className="dk-why" role="alert">
            Identity&rsquo;s approval is NOT for the request you read. Do not run it. Ask the requester to withdraw it, and tell
            engineering.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="adm-callout" role="alert" data-testid="step-reply" data-tone={reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}>
      <strong>{reply.refusal.title}</strong>
      <p>{reply.refusal.body}</p>
      <p>{reply.refusal.next}</p>
      <p className="dk-muted">
        {reply.refusal.changed === 'unknown' ? 'Outcome not known.' : 'Nothing was changed.'}
        {reply.refusal.code ? ` Code: ${reply.refusal.code}` : ''}
      </p>
    </div>
  );
}

export interface WorkbenchViewProps {
  readonly packetText: string;
  readonly reading: PacketReading;
  readonly userId: string;
  readonly confirm: string;
  readonly busy: StepName | null;
  readonly reply: StepReply | null;
  readonly blockedReason: string | null;
  readonly now: Date;
  readonly onPacketText: (value: string) => void;
  readonly onConfirm: (value: string) => void;
  readonly onStep: (step: Exclude<StepName, 'propose'>) => void;
  /** Drops an opened document from the reply, so its contents leave the page. */
  readonly onCloseDocument?: () => void;
  /** Set when running the request needs the runner's own fresh authenticator code; says why. */
  readonly stepUpNote?: string | null;
  readonly stepUpCode?: string;
  readonly onStepUpCode?: (value: string) => void;
}

const STEP_LABEL: Record<Exclude<StepName, 'propose'>, string> = {
  approve: 'Approve this request',
  reject: 'Reject',
  revoke: 'Withdraw my request',
  execute: 'Run the approved request',
};

export function ApprovalWorkbenchView(props: WorkbenchViewProps) {
  // A page can hold more than one desk, so each workbench's ids are its own.
  const uid = useId();
  const { reading, userId, confirm, busy, reply, blockedReason, now } = props;
  const packet: ApprovalPacket | null = reading.ok ? reading.packet : null;
  const phrase = packet ? confirmPhrase(packet.request) : null;
  const role = packet ? roleFor(packet, userId) : 'unknown';
  // Only the founder who asked runs it (the approver never runs their own approval), so only they see the code field.
  const askStepUp = Boolean(props.stepUpNote && packet && needsStepUp(packet.request) && role === 'requester');
  const partialCode = askStepUp && (props.stepUpCode ?? '').length > 0 && (props.stepUpCode ?? '').length < 6;
  const gates = packet
    ? (Object.keys(STEP_LABEL) as Array<Exclude<StepName, 'propose'>>).map((step) => {
        const gate = stepGate({ step, packet, userId, confirm, blockedReason, busy: busy !== null, now });
        return {
          step,
          gate: step === 'execute' && gate.ok && partialCode ? { ok: false as const, why: 'Type all six digits of your code.' } : gate,
        };
      })
    : [];
  const reason = packet ? requestReason(packet.request) : null;
  return (
    <div className="dk-stack" data-testid="approval-workbench">
      <div className="adm-field">
        <label htmlFor={`${uid}dk-packet`}>Request packet</label>
        <textarea
          id={`${uid}dk-packet`}
          className="adm-textarea dk-packet"
          rows={3}
          value={props.packetText}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => props.onPacketText(e.target.value)}
          placeholder="Paste the request packet the other founder sent you (starts with ifa1.)"
        />
      </div>
      {!reading.ok && reading.reason !== 'empty' && (
        <p className="dk-why" role="alert">
          {reading.reason === 'not_a_packet' ? 'That is not a request packet.' : 'That packet is damaged or edited. Ask for a fresh one.'}{' '}
          Nothing was sent.
        </p>
      )}
      {packet && phrase && (
        <>
          <div className="adm-callout" data-testid="packet-summary">
            <strong>{describeRequest(packet.request)}</strong>
            <dl className="dk-kv">
              {reason !== null && (
                <>
                  <dt>Reason given</dt>
                  <dd>{reason}</dd>
                </>
              )}
              <dt>Requested by</dt>
              <dd className="dk-packet">
                {shortId(packet.requesterId)}
                {role === 'requester' ? ' (you)' : ''}
              </dd>
              <dt>Approval expires</dt>
              <dd>{formatWhen(packet.expiresAt)}</dd>
              <dt>Approval id</dt>
              <dd className="dk-packet">{packet.approvalId}</dd>
            </dl>
            <p className="dk-muted">{describePacketStatus(role)}</p>
            <p className="dk-muted">
              This console cannot read whether the other founder has approved yet (identity has no read for that). Running it before they
              have is refused by identity and changes nothing.
            </p>
          </div>
          <div className="adm-field">
            <label htmlFor={`${uid}dk-confirm`}>
              Type <code>{phrase}</code> to approve or run it
            </label>
            <input
              id={`${uid}dk-confirm`}
              className="adm-input"
              value={confirm}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => props.onConfirm(e.target.value)}
            />
          </div>
          {askStepUp && (
            <div className="adm-field">
              <label htmlFor={`${uid}dk-step-up`}>Your authenticator code, to run it</label>
              <input
                id={`${uid}dk-step-up`}
                className="adm-input"
                value={props.stepUpCode ?? ''}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                aria-describedby={`${uid}dk-step-up-note`}
                onChange={(e) => props.onStepUpCode?.(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <p id={`${uid}dk-step-up-note`} className="dk-muted">
                {props.stepUpNote}
              </p>
            </div>
          )}
          <div className="dk-row">
            {gates.map(({ step, gate }) => (
              <button
                key={step}
                type="button"
                className="adm-btn"
                data-tone={step === 'execute' ? 'danger' : step === 'approve' ? 'primary' : undefined}
                disabled={!gate.ok}
                aria-describedby={gate.ok ? undefined : `${uid}dk-why-${step}`}
                title={gate.ok ? undefined : gate.why}
                onClick={() => props.onStep(step)}
              >
                {busy === step ? 'Working…' : STEP_LABEL[step]}
              </button>
            ))}
          </div>
          {gates
            .filter((g) => !g.gate.ok && (g.step === 'execute' || g.step === 'approve'))
            .slice(0, 1)
            .map((g) => (
              <p key={g.step} id={`${uid}dk-why-${g.step}`} className="dk-why">
                {g.gate.ok ? null : g.gate.why}
              </p>
            ))}
        </>
      )}
      {reply && <StepReplyView reply={reply} onCloseDocument={props.onCloseDocument} />}
    </div>
  );
}

export interface WorkbenchProps {
  readonly endpoint: ApprovalEndpoint;
  readonly packetText: string;
  readonly onPacketText: (value: string) => void;
  readonly userId: string;
  readonly blockedReason: string | null;
  /** Called after any step that reached the service, so the desk re-reads the real state. */
  readonly onChanged: () => void;
  /** The newest reply from the request form, so it shows in the same place. */
  readonly externalReply?: StepReply | null;
  /** Set when running needs the runner's fresh authenticator code (a same-person step-up); says why. */
  readonly stepUpNote?: string | null;
  /** Optional: the reply of every step, before the desk re-reads (see `ControlDesk`). */
  readonly onStepReply?: (reply: StepReply) => void;
}

export function ApprovalWorkbench({
  endpoint,
  packetText,
  onPacketText,
  userId,
  blockedReason,
  onChanged,
  externalReply,
  stepUpNote = null,
  onStepReply,
}: WorkbenchProps) {
  const [confirm, setConfirm] = useState('');
  const [stepUpCode, setStepUpCode] = useState('');
  const [busy, setBusy] = useState<StepName | null>(null);
  const [reply, setReply] = useState<StepReply | null>(null);
  const lock = useRef(false);
  const reading = decodePacket(packetText);

  async function onStep(step: Exclude<StepName, 'propose'>) {
    if (lock.current || !reading.ok) return;
    lock.current = true;
    setBusy(step);
    setReply(null);
    try {
      const { packet } = reading;
      const result = await postStep(endpoint, {
        step,
        request: packet.request,
        confirm,
        approvalId: packet.approvalId,
        ...(step === 'execute' ? { operationId: packet.operationId } : {}),
        ...(step === 'execute' && stepUpNote && needsStepUp(packet.request) && /^\d{6}$/.test(stepUpCode) ? { stepUpCode } : {}),
      });
      // A code is spent once, whatever the reply.
      if (step === 'execute') setStepUpCode('');
      setReply(result);
      if (result.ok && (step === 'reject' || step === 'revoke')) setConfirm('');
      onStepReply?.(result);
      onChanged();
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <ApprovalWorkbenchView
      packetText={packetText}
      reading={reading}
      userId={userId}
      confirm={confirm}
      busy={busy}
      reply={reply ?? externalReply ?? null}
      blockedReason={blockedReason}
      now={new Date()}
      onPacketText={(v) => {
        onPacketText(v);
        setReply(null);
        setConfirm('');
      }}
      onConfirm={setConfirm}
      onStep={(step) => void onStep(step)}
      onCloseDocument={() => setReply(DOCUMENT_CLOSED_REPLY)}
      stepUpNote={stepUpNote}
      stepUpCode={stepUpCode}
      onStepUpCode={setStepUpCode}
    />
  );
}
