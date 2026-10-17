'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Field, Input, KeyValue, SegmentedControl } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { RESTRICTION_ACTION_TYPE, restrictionTargetId, wordsForApprovalCode } from '@/lib/trade-ops/approvals';
import { REASON_MAX, REASON_MIN, REFUSAL_WORDS, isVersion, wordsForRefusal } from '@/lib/trade-ops/restrictions';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { ActionApproval } from '@intafaced/contracts';
import { BlockerPanel } from './blocker-panel';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';
import { recordApproval } from './approvals-log';

/**
 * Panel (b): ask for a restriction change. Two forms.
 *   1. Propose: creates the approval request in identity (real call). The second person approves it by id.
 *   2. Apply: the complete form for applying an approved request (restrict/restore, reason, expected version,
 *      approval id, request id). It is refused with the named blocker restriction_no_four_eyes until the action
 *      type exists in svc-identity / svc-trade, and it says so before and after you press it.
 */
export function ApprovalsPropose(props: { sessionUserId: string; userId: string; version: string | null; restricted: boolean | null }) {
  const [change, setChange] = useState<'restrict' | 'restore'>(props.restricted ? 'restore' : 'restrict');
  const [reason, setReason] = useState('');
  const [version, setVersion] = useState(props.version ?? '');
  const [approvalId, setApprovalId] = useState('');
  const [requestId, setRequestId] = useState('');
  const [proposed, setProposed] = useState<Outcome<ActionApproval> | null>(null);

  useEffect(() => {
    setRequestId(crypto.randomUUID());
  }, []);
  useEffect(() => {
    setVersion(props.version ?? '');
    setChange(props.restricted ? 'restore' : 'restrict');
  }, [props.version, props.restricted, props.userId]);

  const reasonLen = reason.trim().length;
  const reasonError =
    reason && (reasonLen < REASON_MIN || reasonLen > REASON_MAX) ? `${REASON_MIN} to ${REASON_MAX} characters.` : undefined;
  const versionError = version && !isVersion(version) ? 'Digits only, as shown in the account state.' : undefined;
  const ready = !!props.userId && reasonLen >= REASON_MIN && reasonLen <= REASON_MAX && isVersion(version);
  const verb = change === 'restrict' ? 'Restrict trading' : 'Lift the trading restriction';

  const body = { userId: props.userId, change, reason: reason.trim(), expectedVersion: version };

  async function propose(): Promise<Outcome<unknown>> {
    const out = await tradeOpsAction<ActionApproval>('approvals', { action: 'propose', ...body });
    setProposed(out);
    recordApproval({
      at: out.asOf,
      actorUserId: props.sessionUserId,
      verb: 'propose',
      approvalId: out.kind === 'ok' ? out.data.approvalId : null,
      actionType: RESTRICTION_ACTION_TYPE,
      targetId: restrictionTargetId(props.userId),
      requesterId: out.kind === 'ok' ? out.data.requesterId : props.sessionUserId,
      reason: reason.trim(),
      outcome: out.kind === 'ok' ? 'ok' : out.kind,
      result: out.kind === 'ok' ? out.data.status : out.kind === 'refused' ? out.code : '',
    });
    return out;
  }

  return (
    <div className="flex flex-col gap-6">
      {!props.userId ? (
        <p className="text-sm text-fg-2">Look an account up first. The change is written against the version you see there.</p>
      ) : null}
      <fieldset className="flex flex-col gap-3" disabled={!props.userId}>
        <legend className="mb-1 text-sm font-medium text-fg">Change to ask for</legend>
        <SegmentedControl
          aria-label="Restrict or restore"
          size={32}
          value={change}
          onValueChange={(v) => setChange(v === 'restore' ? 'restore' : 'restrict')}
          items={[
            { value: 'restrict', label: 'Restrict trading' },
            { value: 'restore', label: 'Lift restriction' },
          ]}
        />
        <Field
          label="Reason"
          hint={`${REASON_MIN} to ${REASON_MAX} characters. Kept in the account's history.`}
          error={reasonError}
          density="dense"
        >
          <Input value={reason} onValueChange={setReason} density="dense" autoComplete="off" />
        </Field>
        <Field
          label="Expected version"
          hint="The account state version you looked at. If it changed since, the service refuses (version conflict)."
          error={versionError}
          density="dense"
          className="w-48"
        >
          <Input value={version} onValueChange={setVersion} density="dense" autoComplete="off" />
        </Field>
      </fieldset>

      <section aria-label="Propose" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">1. Ask a second person to approve</h3>
        <p className="text-xs text-fg-3">
          Creates an approval request in identity. It does not change the account. A different signed-in operator must approve it by id, and
          you cannot approve your own.
        </p>
        <div>
          <ConfirmAction
            trigger="Propose for approval"
            title={`${verb}: propose`}
            consequence={
              <>
                Creates a request to <strong>{verb.toLowerCase()}</strong> for account <code className="if-num">{props.userId || '—'}</code>{' '}
                at version <span className="if-num">{version || '—'}</span>. Nothing on the account changes yet. Give the approval id to the
                second operator.
              </>
            }
            confirmLabel="Create request"
            reasonMin={0}
            triggerVariant="primary"
            disabled={!ready}
            disabledReason="Fill in the account, reason and version first."
            run={propose}
          />
        </div>
        {proposed?.kind === 'ok' ? (
          <div className="flex flex-col gap-2 rounded-sm border border-line bg-panel p-3">
            <OutcomeNotice outcome={proposed} doneText="Request created" />
            <KeyValue
              density="dense"
              layout="stacked"
              items={[
                { label: 'Approval id (give this to the second operator)', value: proposed.data.approvalId, mono: true },
                { label: 'Payload hash (the approver must have reviewed this)', value: proposed.data.payloadHash, mono: true },
                { label: 'Status', value: proposed.data.status },
                { label: 'Expires', value: proposed.data.expiresAt.replace('T', ' ').slice(0, 19) + ' UTC' },
              ]}
            />
          </div>
        ) : proposed ? (
          <ProposeRefusal outcome={proposed} />
        ) : null}
      </section>

      <section aria-label="Apply" className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
          2. Apply the approved change{' '}
          <Badge tone="warn" density="dense">
            Blocked
          </Badge>
        </h3>
        <BlockerPanel
          blocker={BLOCKERS.restriction_no_four_eyes}
          title="Applying a restriction is not connected to two-person approval"
          size="inline"
        />
        <fieldset className="grid gap-3 md:grid-cols-2" disabled={!props.userId}>
          <Field label="Approval id of an APPROVED request" density="dense">
            <Input value={approvalId} onValueChange={setApprovalId} density="dense" autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            label="Request id"
            hint="One per attempt, so a repeat of the same request is recognised."
            density="dense"
            labelAction={
              <Button type="button" size={28} variant="ghost" shape="rounded" onClick={() => setRequestId(crypto.randomUUID())}>
                New id
              </Button>
            }
          >
            <Input value={requestId} onValueChange={setRequestId} density="dense" autoComplete="off" spellCheck={false} />
          </Field>
        </fieldset>
        <div>
          <ConfirmAction
            trigger={`${verb} now`}
            title={`${verb}: apply`}
            consequence={
              <>
                Would <strong>{verb.toLowerCase()}</strong> for <code className="if-num">{props.userId || '—'}</code> at version{' '}
                <span className="if-num">{version || '—'}</span>, using approval <code className="if-num">{approvalId || '—'}</code>. This
                desk will send the request, and the service side is expected to refuse it with the blocker named above.
              </>
            }
            confirmLabel="Send"
            reasonMin={0}
            tone="danger"
            disabled={!ready || !approvalId.trim() || !requestId}
            disabledReason="Fill in the account, reason, version, approval id and request id first."
            run={() => tradeOpsAction('approvals', { action: 'apply', ...body, approvalId: approvalId.trim(), requestId })}
          />
        </div>
      </section>
    </div>
  );
}

function ProposeRefusal({ outcome }: { outcome: Exclude<Outcome<unknown>, { kind: 'ok' }> }) {
  const words =
    outcome.kind === 'refused'
      ? (wordsForApprovalCode(outcome.code) ?? (outcome.code in REFUSAL_WORDS ? wordsForRefusal(outcome.code) : null))
      : null;
  return (
    <div className="flex flex-col gap-1">
      <OutcomeNotice outcome={outcome} />
      {words ? <p className="text-sm text-fg-2">{words}</p> : null}
    </div>
  );
}
