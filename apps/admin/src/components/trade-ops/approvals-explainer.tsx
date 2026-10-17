'use client';

import { Badge } from '@intafaced/ui';
import { FREEZE_KINDS } from '@/lib/trade-ops/restrictions';

/**
 * The three different "freezes" people mix up, side by side, so an operator picks the right one.
 * Only the first is handled in this room.
 */
export function ApprovalsExplainer() {
  return (
    <ul className="grid gap-3 md:grid-cols-3" aria-label="The three kinds of freeze">
      {FREEZE_KINDS.map((k) => (
        <li key={k.id} className="flex flex-col gap-2 rounded-sm border border-line bg-panel p-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-fg">
            {k.name}
            {k.id === 'trading' ? (
              <Badge tone="lime" density="dense">
                This room
              </Badge>
            ) : null}
          </span>
          <span className="text-fg-2">{k.effect}</span>
          <span className="text-xs text-fg-3">Owner: {k.owner}</span>
          <span className="text-xs text-fg-3">Handled in: {k.where}</span>
        </li>
      ))}
    </ul>
  );
}
