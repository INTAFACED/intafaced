'use client';

import type { ModuleId } from '@intafaced/config';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import type { KillSwitchSnapshot } from '@/lib/control-plane-browser';
import { killBadge, killRefusalFor } from '@/lib/desk/module-kill-model';
import './desk.css';

export interface ModuleKillDeskProps {
  readonly module: ModuleId;
  readonly snapshot: KillSwitchSnapshot | null;
  /** When this console received the snapshot. */
  readonly readAt: string | null;
  readonly loading: boolean;
  /** Deployment reason the control is off (missing edge address or operator credential), or null. */
  readonly writesBlocked: string | null;
  readonly userId: string;
  readonly onReload: () => void;
}

function actionFor(module: ModuleId, killed: boolean): ControlAction {
  return killed
    ? {
        heading: `Re-enable ${module}`,
        submitLabel: 'Ask a second founder to approve re-enabling',
        needsReason: true,
        reasonLabel: 'Why it is safe to re-enable (recorded in the edge audit trail, 12 to 500 characters)',
        build: (reason) => ({ kind: 'edge.kill', module, disabled: false, reason }),
      }
    : {
        heading: `Kill ${module}`,
        submitLabel: 'Ask a second founder to approve the kill',
        needsReason: true,
        reasonLabel: 'Why (recorded in the edge audit trail, 12 to 500 characters)',
        build: (reason) => ({ kind: 'edge.kill', module, disabled: true, reason }),
        danger: true,
      };
}

export function ModuleKillDesk({ module, snapshot, readAt, loading, writesBlocked, userId, onReload }: ModuleKillDeskProps) {
  const badge = killBadge({ module, snapshot, readAt, loading });
  const refusal = killRefusalFor(module);
  const blocked = refusal
    ? refusal.reason
    : (writesBlocked ?? (snapshot ? null : 'The edge state could not be read, so no request can be made. Retry the read first.'));
  const killed = badge.state === 'stopped';
  return (
    <ControlDesk
      endpoint="/api/kill-switch"
      userId={userId}
      blockedReason={blocked}
      action={blocked ? null : actionFor(module, killed)}
      consequence={
        killed
          ? 'Re-enabling lets new commitments through again. Two different operators must agree; this console admits only founders, but identity also accepts other operators on the approval, so check who approved below.'
          : 'A kill refuses new commitments on this module (503) until it is re-enabled; reads and cancels still pass. Two different operators must agree; this console admits only founders, but identity also accepts other operators on the approval, so check who approved below.'
      }
      blockedButtonLabel="Kill / re-enable unavailable"
      onChanged={onReload}
    >
      <div className="dk-badge" data-state={badge.state} data-testid="kill-badge" role="status">
        <strong>{badge.title}</strong>
        <span className="dk-asof">{badge.asOf ? `As of ${badge.asOf} (when this console read the edge)` : 'No successful read yet'}</span>
        {badge.reason && <span className="dk-muted">Recorded reason: {badge.reason}</span>}
        {badge.lastChange && (
          <span className="dk-muted">
            Last change for this module: {badge.lastChange.at}, run with the console credential {badge.lastChange.actor}
            {badge.lastChange.confirmedBy ? `, approved by ${badge.lastChange.confirmedBy}` : ', approver not recorded'}; the requester is
            on the approval record: {badge.lastChange.reason}
          </span>
        )}
      </div>
    </ControlDesk>
  );
}
