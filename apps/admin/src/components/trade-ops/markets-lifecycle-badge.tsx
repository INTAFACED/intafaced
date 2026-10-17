'use client';

import { Badge } from '@intafaced/ui';
import { lifecycleLook, recordStatusLook } from '@/lib/trade-ops/markets-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { LifecycleRow, MarketRecordStatus } from '@/lib/trade-ops/reads';

/** The lifecycle state as a word plus a shape, or the honest reason it could not be read. Never blank, never a guess. */
export function LifecycleBadge({ lifecycle }: { lifecycle: Outcome<LifecycleRow> | null }) {
  if (lifecycle?.kind === 'ok') {
    const look = lifecycleLook(lifecycle.data.state);
    return (
      <Badge tone={look.tone} density="dense" icon={look.glyph}>
        {look.word}
      </Badge>
    );
  }
  const title =
    lifecycle === null
      ? 'Not read: more markets than the page reads at once.'
      : lifecycle.kind === 'refused'
        ? `${lifecycle.code}: ${lifecycle.message}`
        : lifecycle.message;
  return (
    <Badge tone="neutral" variant="outline" density="dense" icon="?" title={title}>
      {lifecycle?.kind === 'refused' ? 'Refused' : 'Unknown'}
    </Badge>
  );
}

export function RecordStatusBadge({ status }: { status: MarketRecordStatus }) {
  const look = recordStatusLook(status);
  return (
    <Badge tone={look.tone} density="dense" icon={look.glyph}>
      {look.word}
    </Badge>
  );
}
