import {
  ownsAll,
  WORK_ITEM_SOURCES,
  WORK_LIST_CAP_UNSET,
  workItemsOutputSchema,
  type HomeConfig,
  type WorkItem,
  type WorkItemKind,
  type WorkItemSource,
} from '@intafaced/contracts/home-work-items';
import { classifyRefusal } from '../../data/refusal-codes';

/**
 * Home's work list (HM-dashboard-03): what needs the person now, merged from each owner's own `workItems.list`. Every
 * row is the owner's record; nothing is stored or invented here. A source that has not answered is named, never read as
 * "nothing needs you".
 */

/** The owners, in the order their answers are merged while the owner has not set an order. */
export const WORK_SOURCES: readonly WorkItemSource[] = [...new Set(Object.values(WORK_ITEM_SOURCES))];

/** One owner's answer as Home holds it. */
export type SourceRead =
  | { state: 'loading' }
  | { state: 'ready'; items: readonly WorkItem[] }
  /** The owner does not answer this read on this deployment yet (no such procedure, or the service is not running). */
  | { state: 'unwired' }
  /** The owner answered with a refusal or an answer Home cannot trust: its code and HTTP status when it gave them. */
  | { state: 'failed'; code?: string; status?: number };

/** The owner values read, as Home holds them. */
export type ConfigRead =
  { state: 'loading' } | { state: 'ready'; config: HomeConfig } | { state: 'unwired' } | { state: 'failed'; code?: string };

export type WorkList =
  | { state: 'loading' }
  /** The list cannot be shown: Home's owner values are blank or unreadable. `code` names why. */
  | { state: 'refused'; code: string }
  | {
      state: 'ready';
      /** The items to show, in order, at most the owner's cap. */
      items: WorkItem[];
      /** Items past the cap. */
      more: number;
      /** Whether the owner set the order; while not, the owners' own order is kept and Home says so. */
      ordered: boolean;
      /** Owners whose answer is not in: not answering on this deployment, or failed. The list waits while any is loading. */
      missing: { source: WorkItemSource; state: 'unwired' | 'failed'; code?: string }[];
    };

/** Home's owner values could not be read on this deployment. */
export const HOME_CONFIG_UNWIRED = 'home.config_unwired' as const;
/** Home's owner values were read but refused or not understood. */
export const HOME_CONFIG_FAILED = 'home.config_failed' as const;

/**
 * An owner's raw answer as a source read: it must parse as the contract and hold only that owner's kinds, else the
 * whole answer is dropped (a row another owner should answer for is never shown on this one's word).
 */
export function sourceAnswer(source: WorkItemSource, answer: unknown): SourceRead {
  const parsed = workItemsOutputSchema.safeParse(answer);
  if (!parsed.success || !ownsAll(source, parsed.data)) return { state: 'failed', code: 'home.work_items_invalid' };
  return { state: 'ready', items: parsed.data.items };
}

/** The list Home shows, from the owner values and each owner's answer. */
export function workList(config: ConfigRead, sources: Readonly<Record<WorkItemSource, SourceRead>>): WorkList {
  if (config.state === 'loading') return { state: 'loading' };
  if (config.state === 'unwired') return { state: 'refused', code: HOME_CONFIG_UNWIRED };
  if (config.state === 'failed') return { state: 'refused', code: config.code ?? HOME_CONFIG_FAILED };
  const { workListCap: cap, workListOrder: order } = config.config;
  if (cap === null) return { state: 'refused', code: WORK_LIST_CAP_UNSET };

  const merged: WorkItem[] = [];
  const missing: Extract<WorkList, { state: 'ready' }>['missing'] = [];
  // While one owner is still loading the list is not final: show it loading rather than a partial list that reshuffles.
  if (WORK_SOURCES.some((source) => sources[source].state === 'loading')) return { state: 'loading' };
  // An owner that refuses until the person is verified (a 403 that says verify first) has nothing of theirs to list yet, and
  // identity's verification item is already the one ask: that refusal is not a source Home failed to check. Without that
  // item, or as any other answer (an outage, a 5xx that happens to name KYC), it stays a failure.
  const identity = sources.identity;
  const asksToVerify = identity.state === 'ready' && identity.items.some((item) => item.kind === 'verification');
  for (const source of WORK_SOURCES) {
    const read = sources[source];
    if (read.state === 'ready') merged.push(...read.items);
    else if (read.state === 'failed' && asksToVerify && read.status === 403 && classifyRefusal(read.code) === 'verify') continue;
    else if (read.state === 'failed') missing.push({ source, state: 'failed', code: read.code });
    else if (read.state === 'unwired') missing.push({ source, state: 'unwired' });
  }

  const rank = (kind: WorkItemKind) => {
    const at = order?.indexOf(kind) ?? -1;
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const sorted = order
    ? merged.map((item, at) => ({ item, at })).sort((a, b) => rank(a.item.kind) - rank(b.item.kind) || a.at - b.at)
    : null;
  const all = sorted ? sorted.map((entry) => entry.item) : merged;
  return { state: 'ready', items: all.slice(0, cap), more: Math.max(0, all.length - cap), ordered: order !== null, missing };
}

/** A ratio from the owner's record ("0.8512", where 1 is 100%) as the percent it reads as ("85.12%"), without a float. */
export function ratioPercent(ratio: string): string {
  const [whole = '0', frac = ''] = ratio.split('.');
  const digits = `${whole}${frac.padEnd(2, '0')}`;
  const point = whole.length + 2;
  const head = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const tail = digits.slice(point).replace(/0+$/, '');
  return `${head}${tail ? `.${tail}` : ''}%`;
}
