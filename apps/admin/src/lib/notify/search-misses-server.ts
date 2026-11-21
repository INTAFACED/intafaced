import 'server-only';
import { type FounderCallContext, partFrom, type Part, type PartLabels, founderRecordRead } from '@/lib/desk';
import { readSearchMisses, SEARCH_MISS_DAYS, type SearchMisses } from './search-misses-model';
import { NOTIFY_NAV_METRICS_SEARCH_MISSES } from '@intafaced/contracts/notify-nav-metrics-procedures';

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage: 'svc-notify did not accept your founder session. Search misses need the operator read permission (admin:read).',
};

/** The founders' read of search misses over the desk's window, as the signed-in founder. Read-only. */
export async function loadSearchMisses(ctx: FounderCallContext): Promise<Part<SearchMisses>> {
  const result = await founderRecordRead(ctx, NOTIFY_NAV_METRICS_SEARCH_MISSES, { days: SEARCH_MISS_DAYS }, readSearchMisses);
  return partFrom(result, (d) => d, LABELS);
}
