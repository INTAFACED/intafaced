'use client';

import { Badge, cn } from '@intafaced/ui';
import type { Outcome } from '@/lib/trade-ops/outcome';

/**
 * Says what happened to an action or read, in words: applied, refused (service code + the real blocker), or unknown.
 * Colour is never the only cue: every state has a label.
 */
export function OutcomeNotice({
  outcome,
  doneText = 'Applied',
  className,
}: {
  outcome: Outcome<unknown>;
  doneText?: string;
  className?: string;
}) {
  const when = outcome.asOf.slice(11, 19);
  if (outcome.kind === 'ok')
    return (
      <p role="status" data-outcome="ok" className={cn('flex flex-wrap items-center gap-2 text-sm', className)}>
        <Badge tone="lime" density="dense">
          {doneText}
        </Badge>
        <span className="text-fg-2">Confirmed by the service at {when} UTC.</span>
      </p>
    );
  if (outcome.kind === 'unknown')
    return (
      <div role="alert" data-outcome="unknown" className={cn('flex flex-col gap-1 text-sm', className)}>
        <Badge tone="warn" density="dense">
          Result unknown
        </Badge>
        <span className="text-fg-2">{outcome.message}</span>
      </div>
    );
  return (
    <div role="alert" data-outcome="refused" className={cn('flex flex-col gap-1 text-sm', className)}>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone="error" density="dense">
          Refused
        </Badge>
        <code className="if-num text-xs text-fg-2">{outcome.code}</code>
      </span>
      <span className="text-fg-2">{outcome.message}</span>
      {outcome.blocker ? (
        <span className="text-xs text-fg-3">
          Blocked by: {outcome.blocker.owner} · requirement {outcome.blocker.need}
        </span>
      ) : null}
    </div>
  );
}
