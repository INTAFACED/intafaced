/**
 * How the new screens talk to the console's own API routes (`/api/crm`, `/api/crm/workflows`). Same error rules as the old
 * workspace: 401/403 is a lost session, 409/412 is "changed or refused" (the revision check said no), anything else is "other".
 */
import type {
  CrmActivity,
  CrmContact,
  CrmOpportunityPage,
  CrmOpportunityRow,
  CrmOrganisation,
  CrmSubmission,
  CrmTask,
  CrmWorkflowsContract,
} from '@intafaced/contracts';
import { workflowUrl } from '@/lib/crm-browser';
import { entriesOf, type QueueEntry } from './queue';

export type CrmErrorKind = 'session' | 'conflict' | 'other';
export class CrmRequestError extends Error {
  constructor(
    message: string,
    readonly kind: CrmErrorKind,
  ) {
    super(message);
  }
}

export async function readJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new CrmRequestError('Your founder session is unavailable. Sign in again.', 'session');
    if (response.status === 409 || response.status === 412)
      throw new CrmRequestError('The enquiry changed or this action was refused. Reload it and review before retrying.', 'conflict');
    throw new CrmRequestError('The workspace could not confirm this request. Refresh the enquiry before retrying.', 'other');
  }
  return (await response.json()) as T;
}
export const failureOf = (failure: unknown, fallback: string): { message: string; kind: CrmErrorKind } => ({
  message: failure instanceof Error ? failure.message : fallback,
  kind: failure instanceof CrmRequestError ? failure.kind : 'other',
});

/** The open enquiry as `/api/crm?opportunityId=` returns it. */
export type Detail = {
  opportunity: CrmOpportunityRow;
  contact: CrmContact;
  organisation: CrmOrganisation | null;
  submission: CrmSubmission;
  activities: CrmActivity[];
  tasks: CrmTask[];
  deliveries?: Array<{ status: string; errorCode: string | null }>;
  provenance: NonNullable<Awaited<ReturnType<CrmWorkflowsContract['getContactProvenance']>>>;
};
export type Metrics = Awaited<ReturnType<CrmWorkflowsContract['metrics']>>;

export const fetchDetail = (id: string) => readJson<Detail | null>(`/api/crm?opportunityId=${encodeURIComponent(id)}`);
export const fetchMetrics = () => readJson<Metrics>(workflowUrl('metrics'));

/** Every open enquiry that is waiting on us, oldest first. Up to five pages of 200; `truncated` says there were more. */
export async function fetchWaiting(): Promise<{ entries: QueueEntry[]; truncated: boolean }> {
  const entries: QueueEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({ queue: 'waiting', limit: '200', ...(cursor ? { cursor } : {}) });
    const result: CrmOpportunityPage = await readJson<CrmOpportunityPage>(`/api/crm?${params}`);
    entries.push(...entriesOf(result));
    cursor = result.nextCursor;
    if (!cursor) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

export type ListFilters = {
  audience?: string;
  stage?: string;
  ownerUserId?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
};
export function fetchList(filters: ListFilters): Promise<CrmOpportunityPage> {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 50) });
  for (const key of ['audience', 'stage', 'ownerUserId', 'query'] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  if (filters.cursor) params.set('cursor', filters.cursor);
  return readJson<CrmOpportunityPage>(`/api/crm?${params}`);
}
