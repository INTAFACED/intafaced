import {
  COMPLIANCE_REVIEW_LEVELS,
  type ComplianceCase,
  type ComplianceCaseStatus,
  type ComplianceInboxFilter,
  type ComplianceReviewLevel,
} from '@intafaced/contracts';

/**
 * Pure model of the case room (OPS-cases-01). Query parameters in, the filter svc-ops understands out. Nothing here counts rows or
 * picks a page size: totals come from the service, and a page size nobody set stays unset until the viewer types one.
 */

export const REVIEW_LABEL: Readonly<Record<ComplianceReviewLevel | 'unset', string>> = {
  green: 'Green',
  yellow: 'Yellow',
  red: 'Red',
  unset: 'Not set',
};

export const STATUS_LABEL: Readonly<Record<ComplianceCaseStatus, string>> = {
  pending: 'Pending',
  cleared: 'Cleared',
  rejected: 'Rejected',
  partner_cleared: 'Cleared by partner',
};

export const TYPE_LABEL: Readonly<Record<ComplianceCase['type'], string>> = { alert: 'Alert', monitoring: 'Monitoring' };

/** What each typed refusal means to an operator. No raw code is shown without a sentence. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'compliance.inbox_forbidden': 'You are not a member of this inbox. Ask its owner for access.',
  'compliance.inbox_not_found': 'No inbox has this id.',
  'compliance.case_not_found': 'No case has this id.',
  'compliance.case_already_open': 'A case with this id is already open in another inbox.',
  'compliance.queue_entity_unknown': 'That subject type is not one a queue can hold. Nothing was stored.',
  'compliance.queue_name_taken': 'A queue with this name and version already exists with a different definition. Use a new version.',
  'compliance.cases_list_limit_unset': 'No page size is set. Enter how many cases to show per page; none is assumed.',
  'ops.compliance_storage_unconfigured': 'svc-ops has no durable storage for cases on this deployment, so nothing can be read or saved.',
};

export function refusalWords(code: string | null): string | null {
  return code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;
}

type Query = Readonly<Record<string, string | string[] | undefined>>;
const one = (q: Query, key: string): string | undefined => {
  const v = q[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
};
const dateStart = (s: string | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : undefined);
const dateEnd = (s: string | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999Z` : undefined);

export interface RoomQuery {
  readonly inboxId: string | null;
  readonly caseId: string | null;
  readonly next: boolean;
  readonly limit: number | null;
  readonly cursor: string | null;
  readonly group: boolean;
  readonly filter: ComplianceInboxFilter;
}

export function parseRoomQuery(q: Query): RoomQuery {
  const level = one(q, 'level');
  const tags = one(q, 'tags')
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  const limitRaw = one(q, 'limit');
  const limit = limitRaw && /^\d{1,3}$/.test(limitRaw) && Number(limitRaw) >= 1 && Number(limitRaw) <= 500 ? Number(limitRaw) : null;
  const from = dateStart(one(q, 'from'));
  const to = dateEnd(one(q, 'to'));
  const assignee = one(q, 'assignee');
  const filter: ComplianceInboxFilter = {
    ...(assignee ? { assignee } : {}),
    ...(one(q, 'closed') === '1' ? { closedOnly: true } : {}),
    ...(one(q, 'unassigned') === '1' ? { unassignedOnly: true } : {}),
    ...(one(q, 'snoozed') === '1' ? { includeSnoozed: true } : {}),
    ...(level && (COMPLIANCE_REVIEW_LEVELS as readonly string[]).includes(level) ? { reviewLevels: [level as ComplianceReviewLevel] } : {}),
    ...(tags && tags.length ? { tags } : {}),
    ...(from ? { createdFrom: from } : {}),
    ...(to ? { createdTo: to } : {}),
  };
  return {
    inboxId: one(q, 'inbox') ?? null,
    caseId: one(q, 'case') ?? null,
    next: one(q, 'next') === '1',
    limit,
    cursor: one(q, 'cursor') ?? null,
    group: one(q, 'group') === '1',
    filter,
  };
}

/** The room's address for an inbox, keeping the viewer's page size. */
export function roomHref(params: Readonly<Record<string, string | null | undefined>>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/compliance/cases?${s}` : '/compliance/cases';
}

export function dueText(c: Pick<ComplianceCase, 'dueAt'>): string {
  return c.dueAt === null ? 'Not set' : c.dueAt;
}
