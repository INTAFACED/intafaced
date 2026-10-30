import { useMemo, type ReactNode } from 'react';
import { useApi } from '../../session/session';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { EmptyState } from '../../../shared/ui';
import { isServiceNotConnected } from '../blockers';
import { createProtocolApi } from '../api';
import type { ChainRef } from '../NetworkPanels';
import type { ExplorerTranslate } from './copy';

/** Pieces every explorer page shares. Kept apart from the pages so the address page can use them without a cycle. */

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** Why the indexer gave no answer, in words. A gateway with no indexer behind it says so instead of a raw code. */
export function refusalWords(failure: Failure, t: ExplorerTranslate): string {
  if (isServiceNotConnected(failure.code)) return t('reasonIndexerNotConnected');
  if (failure.code === 'edge.upstream_unavailable') return t('reasonIndexerNoAnswer');
  return failure.message;
}

export const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/** A table row that holds only a note: why the table is empty, or that it is loading. */
export function NoteRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span}>{children}</td>
    </tr>
  );
}
export function BlockerNote({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div role="status" data-blocker="indexer">
      <EmptyState title={title} />
      {action}
    </div>
  );
}

/** The network the indexer reads, as the protocol service publishes it. Never guessed while it loads or fails. */
export function useChainRef(key: string): ChainRef {
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const chain = useResource((signal) => protocol.chainStatus(signal), `${key}:chain`);
  const { resource } = chain;
  if (resource.status === 'ready') return { status: 'ready', chainId: resource.data.configuredChainId };
  if (resource.status === 'failed') return { status: 'failed', failure: resource.failure, reload: chain.reload };
  return { status: 'loading' };
}
