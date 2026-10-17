'use client';

import { useState } from 'react';
import type { ActionApproval } from '@intafaced/contracts';
import { Button, Field, Input } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { MATCHING_ACTIONS, matchingActionSpec, type MatchingActionName, type MatchingActionSpec } from '@/lib/trade-ops/matching-controls';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * The matching controls, in the order the law requires: operator A files a two-person approval (propose), a different
 * operator approves it in Freezes & approvals with the payload hash, then A runs the control with the approval id. A
 * PENDING approval is shown as pending and run is refused before anything is sent. Every refusal is the service's own.
 */

const COPY: Record<MatchingActionName, { consequence: (target: string) => string; tone?: 'danger' }> = {
  halt: { consequence: (t) => `Stops new orders on ${t}. Resting orders stay on the book and customers can still cancel them.` },
  resume: { consequence: (t) => `Reopens ${t} for new orders. A restart of the matching engine never reopens a market on its own.` },
  reduce_only: {
    consequence: (t) => `${t} accepts only orders that reduce an existing position. New exposure is refused; resting orders stay.`,
  },
  reduce_only_off: { consequence: (t) => `${t} leaves reduce-only and accepts new exposure again.` },
  post_only: { consequence: (t) => `${t} accepts only orders that rest on the book. Orders that would trade at once are refused.` },
  post_only_off: { consequence: (t) => `${t} leaves post-only and accepts orders that trade at once again.` },
  delist: {
    tone: 'danger',
    consequence: (t) =>
      `Ends ${t} for good: resting orders are cancelled, positions are settled and withdrawals are handled. This cannot be undone.`,
  },
  halt_all: {
    tone: 'danger',
    consequence: () => 'Matching stops for every market at once. This is separate from the trade module switch.',
  },
  resume_all: { consequence: () => 'Every market returns to the state its lifecycle allows.' },
};

export function MatchingControls({
  actions,
  marketId = null,
  symbol = null,
}: {
  actions: readonly MatchingActionName[];
  /** The svc-trade market id svc-matching knows the market by. Null for venue-wide controls. */
  marketId?: string | null;
  symbol?: string | null;
}) {
  const [approvalId, setApprovalId] = useState('');
  const [typed, setTyped] = useState('');
  const [filed, setFiled] = useState<ActionApproval | null>(null);
  const [filedFor, setFiledFor] = useState<MatchingActionSpec | null>(null);
  const [status, setStatus] = useState<Outcome<ActionApproval> | null>(null);
  const [checking, setChecking] = useState(false);
  const specs = actions.map((n) => matchingActionSpec(n)).filter((a): a is MatchingActionSpec => a !== null);
  const target = symbol ?? 'every market';
  const send = (action: MatchingActionSpec, step: 'propose' | 'status' | 'run', approval = approvalId) =>
    tradeOpsAction(action.perMarket ? 'markets' : 'kill-switch', {
      action: action.name,
      step,
      marketId: action.perMarket ? marketId : '',
      symbol,
      typedSymbol: typed,
      approvalId: approval,
    });

  async function checkStatus() {
    if (!filed || !filedFor) return;
    setChecking(true);
    const out = (await send(filedFor, 'status', filed.approvalId)) as Outcome<ActionApproval>;
    setChecking(false);
    setStatus(out);
  }

  const pending = status?.kind === 'ok' ? status.data : filed;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Approval id" hint="From Propose approval below, once a different operator has approved it." density="dense">
          <Input density="dense" value={approvalId} onValueChange={setApprovalId} autoComplete="off" spellCheck={false} />
        </Field>
        {specs.some((a) => a.name === 'delist') && symbol ? (
          <Field label={`Type ${symbol} to enable Delist`} hint="Delist only." density="dense">
            <Input density="dense" value={typed} onValueChange={setTyped} autoComplete="off" />
          </Field>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {specs.map((a) => {
          const copy = COPY[a.name];
          const delistBlocked = a.name === 'delist' && typed.trim() !== symbol;
          const delistWhy = delistBlocked ? `Type ${symbol} exactly to enable Delist.` : undefined;
          return (
            <div key={a.name} className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-sm font-medium">{a.label}</span>
              <ConfirmAction
                trigger="Propose approval"
                title={`Propose approval: ${a.label} ${target}`}
                consequence={`${copy.consequence(target)} This only files the request. Nothing changes on the book until a different operator approves it and you run it.`}
                confirmLabel="Propose approval"
                reasonMin={0}
                doneText="Filed, pending"
                disabled={delistBlocked}
                disabledReason={delistWhy}
                run={() => send(a, 'propose')}
                onDone={(o) => {
                  if (o.kind !== 'ok') return;
                  const row = o.data as ActionApproval;
                  setFiled(row);
                  setFiledFor(a);
                  setStatus(null);
                  setApprovalId(row.approvalId);
                }}
              />
              <ConfirmAction
                trigger={a.label}
                title={`${a.label} ${target}`}
                consequence={copy.consequence(target)}
                confirmLabel={a.label}
                tone={copy.tone}
                reasonMin={0}
                disabled={approvalId.trim() === '' || delistBlocked}
                disabledReason={delistWhy ?? 'Enter an approved approval id first.'}
                run={() => send(a, 'run')}
              />
            </div>
          );
        })}
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm" data-testid="pending-approval">
          <p>
            <span className="font-medium">Approval {pending.status === 'PENDING' ? 'pending' : pending.status.toLowerCase()}.</span>{' '}
            {pending.status === 'PENDING'
              ? 'Nothing has changed. A different operator must approve it in Freezes & approvals with the id and hash below.'
              : pending.status === 'APPROVED'
                ? 'A second operator approved it. You can run the control now.'
                : 'This approval cannot run.'}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-fg-3">Approval id</dt>
            <dd className="if-num break-all">{pending.approvalId}</dd>
            <dt className="text-fg-3">Action</dt>
            <dd className="if-num break-all">
              {pending.actionType} · {pending.targetId}
            </dd>
            <dt className="text-fg-3">Payload hash</dt>
            <dd className="if-num break-all">{pending.payloadHash}</dd>
            <dt className="text-fg-3">Expires</dt>
            <dd className="if-num">{pending.expiresAt}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" shape="rounded" size={28} loading={checking} onClick={checkStatus}>
              Check status
            </Button>
            {status ? <OutcomeNotice outcome={status} doneText="Read" /> : null}
          </div>
        </div>
      ) : null}
      <p className="text-xs text-fg-3">
        If a result shows &ldquo;Result unknown&rdquo;, read the state again before repeating: the control may have been applied. An
        approval can be used once; a refused or unknown run needs a new one.
      </p>
    </div>
  );
}

export const MARKET_CONTROL_ACTIONS = MATCHING_ACTIONS.filter((a) => a.perMarket).map((a) => a.name);
export const VENUE_CONTROL_ACTIONS = MATCHING_ACTIONS.filter((a) => !a.perMarket).map((a) => a.name);
