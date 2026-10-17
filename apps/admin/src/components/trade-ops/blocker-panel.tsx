'use client';

import { EmptyState } from '@intafaced/ui';
import type { Blocker, Outcome } from '@/lib/trade-ops/outcome';

/**
 * A room or panel whose service is not there yet: the real blocker, who owns it and the requirement id.
 * Never "coming soon": the operator can read exactly what is missing.
 */
export function BlockerPanel({ blocker, title, size = 'panel' }: { blocker: Blocker; title: string; size?: 'inline' | 'panel' | 'page' }) {
  return <EmptyState variant="refused" size={size} title={title} reason={blocker.text} code={`${blocker.owner} · ${blocker.need}`} />;
}

/** Panel for a read that did not come back: refused (service's words) or unknown (could not reach it). */
export function ReadProblem({ outcome, title }: { outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>; title: string }) {
  if (outcome.kind === 'unknown') return <EmptyState variant="unavailable" size="panel" title={title} reason={outcome.message} />;
  if (outcome.blocker) return <BlockerPanel blocker={outcome.blocker} title={title} />;
  return <EmptyState variant="refused" size="panel" title={title} reason={outcome.message} code={outcome.code} />;
}
