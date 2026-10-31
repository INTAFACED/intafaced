'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ApprovalWorkbench, StepReplyView } from '@/components/approval-workbench';
import { postStep, type ApprovalEndpoint } from '@/lib/desk/approval-browser';
import { confirmPhrase, type DeskRequest } from '@/lib/desk/approval-packet';
import type { StepReply } from '@/lib/desk/approval-types';
import { requestGate, type Gate } from '@/lib/desk/desk-model';
import './desk.css';

/**
 * One two-founder control: the request form, then the workbench for the packet it produces.
 *
 * Used by the module kill desk and the ledger freeze desk. The caller supplies the state badge (children), the
 * single action that is sensible right now (kill when running, re-enable when killed; freeze when open, unfreeze
 * when frozen) and any reason the whole control must stay off. Nothing here knows what a module or a ledger is.
 */

export interface ControlAction {
  readonly heading: string;
  readonly submitLabel: string;
  readonly needsReason: boolean;
  readonly reasonLabel: string;
  readonly build: (reason: string) => DeskRequest;
  readonly danger?: boolean;
}

export interface RequestFormViewProps {
  readonly action: ControlAction;
  readonly reason: string;
  readonly confirm: string;
  readonly phrase: string;
  readonly gate: Gate;
  readonly busy: boolean;
  readonly consequence: string;
  readonly onReason: (v: string) => void;
  readonly onConfirm: (v: string) => void;
  readonly onSubmit: () => void;
}

export function RequestFormView(props: RequestFormViewProps) {
  const { action, gate } = props;
  // A page can hold more than one desk (an account's unfreeze, close and tier desks), so each form's ids are its own.
  const uid = useId();
  return (
    <form
      className="dk-stack"
      data-testid="request-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (gate.ok) props.onSubmit();
      }}
    >
      <h4>{action.heading}</h4>
      <p className="dk-muted">{props.consequence}</p>
      {action.needsReason && (
        <div className="adm-field">
          <label htmlFor={`${uid}dk-reason`}>{action.reasonLabel}</label>
          <textarea
            id={`${uid}dk-reason`}
            className="adm-textarea"
            rows={3}
            value={props.reason}
            maxLength={500}
            onChange={(e) => props.onReason(e.target.value)}
            disabled={props.busy}
          />
        </div>
      )}
      <div className="adm-field">
        <label htmlFor={`${uid}dk-request-confirm`}>
          Type <code>{props.phrase}</code> to confirm
        </label>
        <input
          id={`${uid}dk-request-confirm`}
          className="adm-input"
          value={props.confirm}
          autoComplete="off"
          spellCheck={false}
          disabled={props.busy}
          onChange={(e) => props.onConfirm(e.target.value)}
        />
      </div>
      <div className="dk-row">
        <button type="submit" className="adm-btn" data-tone={action.danger ? 'danger' : 'primary'} disabled={!gate.ok}>
          {props.busy ? 'Sending…' : action.submitLabel}
        </button>
        {!gate.ok && <span className="dk-why">{gate.why}</span>}
      </div>
    </form>
  );
}

export interface ControlDeskProps {
  readonly endpoint: ApprovalEndpoint;
  readonly userId: string;
  /** Why the whole control is off, or null. Shown instead of the form; the workbench (reject, withdraw) stays reachable. */
  readonly blockedReason: string | null;
  readonly action: ControlAction | null;
  readonly consequence: string;
  /** Label for the disabled button shown beside the reason when the control is off. */
  readonly blockedButtonLabel: string;
  /**
   * Why the REQUEST FORM cannot send yet (a target still to be typed), or null. Unlike `blockedReason` it leaves the workbench
   * alone, so the other founder can still approve and run a request made elsewhere.
   */
  readonly formHold?: string | null;
  /** Set when running needs the runner's fresh authenticator code (a same-person step-up); says why. */
  readonly stepUpNote?: string | null;
  readonly onChanged: () => void;
  readonly children?: ReactNode;
}

export function ControlDesk({
  endpoint,
  userId,
  blockedReason,
  action,
  consequence,
  blockedButtonLabel,
  formHold = null,
  stepUpNote = null,
  onChanged,
  children,
}: ControlDeskProps) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [packetText, setPacketText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<StepReply | null>(null);
  const lock = useRef(false);
  const uid = useId();

  const request = action ? action.build(reason.trim()) : null;
  const phrase = request ? confirmPhrase(request) : '';
  const gate: Gate = action
    ? requestGate({ reason, needsReason: action.needsReason, confirm, phrase, blockedReason: blockedReason ?? formHold, busy })
    : { ok: false, why: blockedReason ?? 'No request is possible right now.' };

  async function submit() {
    if (lock.current || !action || !request || !gate.ok) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postStep(endpoint, { step: 'propose', request, confirm });
      setReply(result);
      if (result.ok && result.step === 'propose' && result.packet) {
        setPacketText(result.packet);
        setReason('');
        setConfirm('');
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function copyPacket() {
    try {
      await navigator.clipboard.writeText(packetText);
    } catch {
      // Clipboard can be blocked. The packet is in the box below to select by hand.
    }
  }

  return (
    <div className="dk" data-testid="control-desk">
      {children}
      {blockedReason && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="control-blocked">
          <strong>This control is switched off</strong>
          <p id={`${uid}dk-blocked-why`}>{blockedReason}</p>
          <button type="button" className="adm-btn" disabled aria-describedby={`${uid}dk-blocked-why`}>
            {blockedButtonLabel}
          </button>
        </div>
      )}
      {action && !blockedReason && (
        <RequestFormView
          action={action}
          reason={reason}
          confirm={confirm}
          phrase={phrase}
          gate={gate}
          busy={busy}
          consequence={consequence}
          onReason={setReason}
          onConfirm={setConfirm}
          onSubmit={() => void submit()}
        />
      )}
      {reply && !reply.ok && <StepReplyView reply={reply} />}
      {reply?.ok && reply.step === 'propose' && (
        <div className="adm-callout" data-testid="packet-made">
          <strong>Request made. Send this packet to the other founder.</strong>
          <p className="dk-muted">
            They paste it below on their own console, read it, and approve it. It is not a secret key, and an edited packet cannot get a
            different request approved.
          </p>
          <div className="dk-row">
            <button type="button" className="adm-btn" onClick={() => void copyPacket()}>
              Copy packet
            </button>
          </div>
        </div>
      )}
      <div className="dk-step">
        <h4>Approve, reject, withdraw or run a request</h4>
        <ApprovalWorkbench
          endpoint={endpoint}
          packetText={packetText}
          onPacketText={setPacketText}
          userId={userId}
          blockedReason={blockedReason}
          onChanged={onChanged}
          stepUpNote={stepUpNote}
        />
      </div>
    </div>
  );
}
