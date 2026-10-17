'use client';

import { useState } from 'react';
import { Field, Input } from '@intafaced/ui';
import { MARKET_ACTIONS, validateMarketAction, type MarketActionName } from '@/lib/trade-ops/markets-model';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { ConfirmAction } from './confirm-action';

/**
 * The five market actions. Each shows its plain consequence, asks for a reason of 12+ characters, and needs the
 * second operator's id and approval id where two people are required (halt, resume, delist). Delist also needs the
 * symbol typed back. The console checks all of it again, then answers with the real blocker (svc-edge has no operator
 * route to svc-matching yet): nothing is sent and nothing is shown as done.
 */

const COPY: Record<MarketActionName, { title: string; consequence: (s: string) => string; confirm: string; tone?: 'danger' }> = {
  halt: {
    title: 'Halt',
    confirm: 'Halt market',
    consequence: (s) =>
      `Stops new orders on ${s}. Resting orders stay on the book and customers can still cancel them. It can be reversed by Resume, which needs two different operators.`,
  },
  reduce_only: {
    title: 'Reduce-only',
    confirm: 'Set reduce-only',
    consequence: (s) => `${s} accepts only orders that reduce an existing position. New exposure is refused; resting orders stay.`,
  },
  post_only: {
    title: 'Post-only',
    confirm: 'Set post-only',
    consequence: (s) => `${s} accepts only orders that rest on the book. Orders that would trade at once are refused; resting orders stay.`,
  },
  resume: {
    title: 'Resume',
    confirm: 'Resume market',
    consequence: (s) =>
      `Reopens ${s} for new orders. Needs two different operators. A restart of the matching engine never reopens a market on its own.`,
  },
  delist: {
    title: 'Delist',
    confirm: 'Delist market',
    tone: 'danger',
    consequence: (s) =>
      `Ends ${s} for good: resting orders are cancelled, positions are settled and withdrawals are handled. This cannot be undone. Needs two different operators and the symbol typed back.`,
  },
};

export function MarketActions({ symbol, currentState }: { symbol: string; currentState: string | null }) {
  const [second, setSecond] = useState('');
  const [approval, setApproval] = useState('');
  const [typed, setTyped] = useState('');

  const body = (action: MarketActionName, reason: string) => ({
    action,
    symbol,
    reason,
    confirmOperatorId: second,
    approvalId: approval,
    typedSymbol: typed,
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">
        Current lifecycle state: <span className="font-medium text-fg">{currentState ?? 'not known'}</span>. Fill the second-person fields
        once; they apply to the action you open.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Second operator id" hint="A different person from you. Required for halt, resume and delist." density="dense">
          <Input density="dense" value={second} onValueChange={setSecond} autoComplete="off" />
        </Field>
        <Field label="Approval id" hint="The id of the approval that person issued." density="dense">
          <Input density="dense" value={approval} onValueChange={setApproval} autoComplete="off" />
        </Field>
        <Field label={`Type ${symbol} to enable Delist`} hint="Delist only." density="dense">
          <Input density="dense" value={typed} onValueChange={setTyped} autoComplete="off" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {MARKET_ACTIONS.map((rule) => {
          const copy = COPY[rule.name];
          const pre = validateMarketAction({ ...body(rule.name, 'x'.repeat(12)) }, '');
          return (
            <ConfirmAction
              key={rule.name}
              trigger={copy.title}
              title={`${copy.title} ${symbol}`}
              consequence={copy.consequence(symbol)}
              confirmLabel={copy.confirm}
              tone={copy.tone}
              reasonMin={12}
              disabled={!pre.ok}
              disabledReason={pre.ok ? undefined : pre.message}
              run={(reason) => tradeOpsAction('markets', body(rule.name, reason))}
            />
          );
        })}
      </div>
      <p className="text-xs text-fg-3">
        A button that is greyed out is waiting for the second person&apos;s details (hover it to read what is missing). If a result ever
        shows &ldquo;Result unknown&rdquo;, read the lifecycle state again before repeating: a lost halt reply keeps new orders off until a
        read shows otherwise.
      </p>
    </div>
  );
}
