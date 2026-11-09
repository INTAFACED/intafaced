import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { readSearchMisses, SEARCH_MISS_DAYS, type SearchMisses } from './search-misses-model';

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage: 'svc-notify did not accept your founder session. Search misses need the operator read permission (admin:read).',
};

/** The founders' read of search misses over the desk's window, as the signed-in founder. Read-only. */
export async function loadSearchMisses(ctx: FounderCallContext): Promise<Part<SearchMisses>> {
  const result = await founderCall(ctx, 'notify', 'navMetrics.searchMisses', 'GET', { days: SEARCH_MISS_DAYS }, readSearchMisses);
  return partFrom(result, (d) => d, LABELS);
}
