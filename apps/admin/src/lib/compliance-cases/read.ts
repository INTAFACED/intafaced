import 'server-only';
import {
  complianceCaseSchema,
  complianceCasesListOutputSchema,
  complianceInboxEntrySchema,
  type ComplianceCase,
  type ComplianceCasesListOutput,
  type ComplianceInboxEntry,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { refusalWords, type RoomQuery } from './model';

const labels = {
  service: 'svc-ops',
  forbiddenMessage:
    'svc-ops did not accept this founder session for compliance cases. It needs the compliance permission (admin:compliance).',
  refusedMessage: refusalWords,
} as const;

type Raw = Record<string, unknown> | null;
const obj = (raw: unknown): Raw => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null);

function parseInboxList(raw: unknown): { inboxes: ComplianceInboxEntry[] } | null {
  const list = obj(raw)?.inboxes;
  if (!Array.isArray(list)) return null;
  const parsed = list.map((e) => complianceInboxEntrySchema.safeParse(e));
  return parsed.every((p) => p.success) ? { inboxes: parsed.map((p) => (p as { data: ComplianceInboxEntry }).data) } : null;
}

function parseNext(raw: unknown): { case: ComplianceCase | null } | null {
  const c = obj(raw)?.case;
  if (c === null) return { case: null };
  const parsed = complianceCaseSchema.safeParse(c);
  return parsed.success ? { case: parsed.data } : null;
}

export interface InboxAccess {
  readonly inboxId: string;
  readonly name: string;
  readonly owner: string;
  readonly member: boolean;
}

function parseAccess(raw: unknown): InboxAccess | null {
  const o = obj(raw);
  if (!o || typeof o.inboxId !== 'string' || typeof o.name !== 'string' || typeof o.owner !== 'string' || typeof o.member !== 'boolean')
    return null;
  return { inboxId: o.inboxId, name: o.name, owner: o.owner, member: o.member };
}

export interface CaseRoom {
  readonly asOf: string;
  readonly inboxes: Part<readonly ComplianceInboxEntry[]>;
  /** Null until an inbox is chosen. */
  readonly list: Part<ComplianceCasesListOutput> | null;
  /** The case open in the preview pane: picked in the list, typed into the jump box, or the next unassigned one. */
  readonly preview: Part<ComplianceCase> | null;
  /** The next-unassigned action found nothing. An honest empty, not a failure. */
  readonly nextEmpty: boolean;
  readonly access: Part<InboxAccess> | null;
}

/** Everything the room shows, each part read on its own so one failure never hides the others. */
export async function readCaseRoom(ctx: FounderCallContext, q: RoomQuery): Promise<CaseRoom> {
  const inboxes = partFrom(
    await founderCall(ctx, 'ops', 'compliance.inboxes.list', 'GET', undefined, parseInboxList),
    (d) => d.inboxes,
    labels,
  );
  let list: CaseRoom['list'] = null;
  let access: CaseRoom['access'] = null;
  if (q.inboxId) {
    const result = await founderCall(
      ctx,
      'ops',
      'compliance.cases.list',
      'GET',
      {
        inboxId: q.inboxId,
        filter: q.filter,
        groupByReviewLevel: q.group,
        ...(q.limit !== null ? { limit: q.limit } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
      parseWith(complianceCasesListOutputSchema),
    );
    list = partFrom(result, (d) => d, labels);
    if (result.kind === 'refused' && result.refusal.code === 'compliance.inbox_forbidden') {
      access = partFrom(
        await founderCall(ctx, 'ops', 'compliance.inboxes.access', 'GET', { inboxId: q.inboxId }, parseAccess),
        (d) => d,
        labels,
      );
    }
  }
  let preview: CaseRoom['preview'] = null;
  let nextEmpty = false;
  if (q.caseId) {
    preview = partFrom(
      await founderCall(ctx, 'ops', 'compliance.cases.getById', 'GET', { id: q.caseId }, parseWith(complianceCaseSchema)),
      (d) => d,
      labels,
    );
  } else if (q.next && q.inboxId) {
    const found = partFrom(
      await founderCall(ctx, 'ops', 'compliance.cases.next', 'GET', { inboxId: q.inboxId }, parseNext),
      (d) => d.case,
      labels,
    );
    if (found.kind === 'ok') {
      if (found.data) preview = { kind: 'ok', data: found.data };
      else nextEmpty = true;
    } else preview = found;
  }
  return { asOf: new Date().toISOString(), inboxes, list, preview, nextEmpty, access };
}
