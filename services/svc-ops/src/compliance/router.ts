import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  COMPLIANCE_CASE_KINDS,
  COMPLIANCE_CASE_TYPES,
  COMPLIANCE_ENTITY_TYPES,
  complianceCaseSchema,
  complianceCasesListInputSchema,
  complianceCasesListOutputSchema,
  complianceInboxEntrySchema,
  complianceInboxSchema,
  complianceQueueBusinessKey,
  complianceQueueDefineInputSchema,
  router,
  scopedProcedure,
  type ComplianceCase,
  type ComplianceEntityType,
  type ComplianceInbox,
} from '@intafaced/contracts';
import {
  COMPLIANCE_CASE_NOT_FOUND,
  COMPLIANCE_CASES_LIST_LIMIT_UNSET,
  COMPLIANCE_INBOX_FORBIDDEN,
  COMPLIANCE_INBOX_NOT_FOUND,
  COMPLIANCE_QUEUE_ENTITY_UNKNOWN,
  COMPLIANCE_QUEUE_NAME_TAKEN,
  OPS_COMPLIANCE_STORAGE_UNCONFIGURED,
  OpsError,
} from '../codes.js';
import { assertOpsListLimit } from '../list-limit.js';
import { isMember, mergeFilter, type CaseCursor, type ComplianceStore } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

/** The operator scope for case work. `admin:compliance` expands to the read scope. */
const operatorScope = 'admin:compliance' as const;

function complianceError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === COMPLIANCE_INBOX_FORBIDDEN
        ? 'FORBIDDEN'
        : err.code === COMPLIANCE_CASE_NOT_FOUND || err.code === COMPLIANCE_INBOX_NOT_FOUND
          ? 'NOT_FOUND'
          : err.code === COMPLIANCE_QUEUE_NAME_TAKEN
            ? 'CONFLICT'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

const encodeCursor = (c: CaseCursor) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decodeCursor(raw: string): CaseCursor {
  try {
    return z
      .object({ createdAt: z.string().datetime({ offset: true }), id: z.string() })
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cursor is not one this list returned' });
  }
}

/** Stable id of a queue: the business key `compliance:queue:<name>:<version>`, hashed. */
const inboxId = (name: string, version: number): string =>
  `inb_${createHash('sha256').update(complianceQueueBusinessKey(name, version)).digest('hex').slice(0, 24)}`;

const entityTypes = new Set<string>(COMPLIANCE_ENTITY_TYPES);

const openInputSchema = z.object({
  /** The business key of the case. Opening the same id twice stores one case. */
  id: z.string().trim().min(1).max(128),
  inboxId: z.string().min(1).max(128),
  kind: z.enum(COMPLIANCE_CASE_KINDS),
  type: z.enum(COMPLIANCE_CASE_TYPES).default('alert'),
  subjectId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  openedAt: z.string().datetime({ offset: true }).optional(),
});

export function createComplianceRouter(store: ComplianceStore | undefined, now: () => string) {
  const need = (): ComplianceStore => {
    if (!store) {
      throw new OpsError(
        OPS_COMPLIANCE_STORAGE_UNCONFIGURED,
        'No durable storage is configured for compliance cases. Nothing was saved, and no case is listed.',
      );
    }
    return store;
  };
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      return complianceError(err);
    }
  };
  const reader = scopedProcedure(operatorScope, guards);
  /** A non-member is told whom to ask, and sees no row and no count. */
  const memberInbox = async (s: ComplianceStore, id: string, operator: string): Promise<ComplianceInbox> => {
    const inbox = await s.getInbox(id);
    if (!inbox) throw new OpsError(COMPLIANCE_INBOX_NOT_FOUND, 'No such inbox.');
    if (!isMember(inbox, operator)) {
      throw new OpsError(COMPLIANCE_INBOX_FORBIDDEN, `You are not a member of this inbox. Ask its owner (${inbox.owner}) for access.`);
    }
    return inbox;
  };

  const inboxes = router({
    list: reader.output(z.object({ inboxes: z.array(complianceInboxEntrySchema) })).query(({ ctx }) =>
      guarded(async () => {
        const s = need();
        const at = now();
        const rows = await s.inboxesFor(ctx.principal.userId);
        const entries = await Promise.all(
          rows.map(async ({ inbox, favourite }) => {
            const { members: _members, ...visible } = inbox;
            return { inbox: visible, member: true, favourite, openCount: await s.openCount(inbox.id, at) };
          }),
        );
        return { inboxes: entries };
      }),
    ),

    /** For the access panel: who owns the inbox and whether the caller is a member. No rows, no count. */
    access: reader
      .input(z.object({ inboxId: z.string().min(1).max(128) }))
      .output(z.object({ inboxId: z.string(), name: z.string(), owner: z.string(), member: z.boolean() }))
      .query(({ input, ctx }) =>
        guarded(async () => {
          const inbox = await need().getInbox(input.inboxId);
          if (!inbox) throw new OpsError(COMPLIANCE_INBOX_NOT_FOUND, 'No such inbox.');
          return { inboxId: inbox.id, name: inbox.name, owner: inbox.owner, member: isMember(inbox, ctx.principal.userId) };
        }),
      ),

    setFavourite: reader
      .input(z.object({ inboxId: z.string().min(1).max(128), favourite: z.boolean() }))
      .output(z.object({ inboxId: z.string(), favourite: z.boolean() }))
      .mutation(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          await memberInbox(s, input.inboxId, ctx.principal.userId);
          await s.setFavourite(ctx.principal.userId, input.inboxId, input.favourite, now());
          return { inboxId: input.inboxId, favourite: input.favourite };
        }),
      ),

    /** Defines a queue. The business key is `compliance:queue:<name>:<version>`: a repeat returns the stored definition. */
    define: scopedProcedure('admin:write', guards)
      .input(complianceQueueDefineInputSchema)
      .output(complianceInboxSchema)
      .mutation(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          if (!ctx.principal.mfa) {
            throw new OpsError(COMPLIANCE_INBOX_FORBIDDEN, 'Defining a queue needs a second factor on this session.');
          }
          if (!entityTypes.has(input.entityType)) {
            throw new OpsError(COMPLIANCE_QUEUE_ENTITY_UNKNOWN, `Unknown entity type "${input.entityType}". Nothing was stored.`);
          }
          const owner = ctx.principal.userId;
          return s.defineInbox(
            {
              id: inboxId(input.name, input.version),
              name: input.name,
              version: input.version,
              entityType: input.entityType as ComplianceEntityType,
              workflow: input.workflow,
              filter: input.filter,
              owner,
              members: [...new Set(input.members)],
              createdAt: now(),
            },
            owner,
          );
        }),
      ),
  });

  const cases = router({
    list: reader
      .input(complianceCasesListInputSchema)
      .output(complianceCasesListOutputSchema)
      .query(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          const limit = assertOpsListLimit(input.limit, COMPLIANCE_CASES_LIST_LIMIT_UNSET);
          const inbox = await memberInbox(s, input.inboxId, ctx.principal.userId);
          const found = await s.list({
            inboxId: inbox.id,
            filter: mergeFilter(inbox.filter, input.filter),
            now: now(),
            limit: limit + 1,
            ...(input.cursor ? { after: decodeCursor(input.cursor) } : {}),
          });
          const page = found.rows.slice(0, limit);
          const last = page[page.length - 1];
          return {
            rows: page,
            total: found.total,
            nextCursor: found.rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
            groups: input.groupByReviewLevel ? found.groups : null,
          };
        }),
      ),

    getById: reader
      .input(z.object({ id: z.string().trim().min(1).max(128) }))
      .output(complianceCaseSchema)
      .query(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          const found = await s.getCase(input.id);
          if (!found) throw new OpsError(COMPLIANCE_CASE_NOT_FOUND, 'No case has this id.');
          await memberInbox(s, found.inboxId, ctx.principal.userId);
          return found;
        }),
      ),

    /** The next open, unassigned case of the inbox in stable order. Null is an honest empty, not an error. */
    next: reader
      .input(z.object({ inboxId: z.string().min(1).max(128) }))
      .output(z.object({ case: complianceCaseSchema.nullable() }))
      .query(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          const inbox = await memberInbox(s, input.inboxId, ctx.principal.userId);
          return { case: await s.nextUnassigned(inbox.id, inbox.filter, now()) };
        }),
      ),

    /** Stores a case. The case id is the business key, so a replay returns the stored case. */
    open: reader
      .input(openInputSchema)
      .output(z.object({ case: complianceCaseSchema, created: z.boolean() }))
      .mutation(({ input, ctx }) =>
        guarded(async () => {
          const s = need();
          const inbox = await s.getInbox(input.inboxId);
          if (!inbox)
            throw new OpsError(COMPLIANCE_INBOX_NOT_FOUND, 'No such inbox. A case is never opened into an inbox that does not exist.');
          const at = input.openedAt ?? now();
          const c: ComplianceCase = {
            id: input.id,
            name: input.name ?? `${input.kind} ${input.subjectId}`,
            kind: input.kind,
            type: input.type,
            subjectId: input.subjectId,
            entityType: inbox.entityType,
            inboxId: inbox.id,
            status: 'pending',
            reviewLevel: null,
            assignee: null,
            tags: input.tags,
            snoozedUntil: null,
            dueAt: null,
            createdAt: at,
            updatedAt: at,
          };
          return s.openCase(c, ctx.principal.userId);
        }),
      ),
  });

  return router({ inboxes, cases });
}
