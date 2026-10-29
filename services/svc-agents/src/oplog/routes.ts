import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';

/**
 * The operator's agent action log (AG-audit-01, AG-audit-02): one customer's agent actions as the service recorded them,
 * read by a signed-in operator (`admin:read`) for a reason picked from the owner's list. Every read, export and
 * transcript open writes one `agent_log_reads` row in the same transaction as the read, so there is no read without its
 * audit row. The list never carries prompt or answer text; only a transcript open does, while the owner's retention
 * keeps it, and its sha256 is checked against the action row's own input digest.
 */

export type OpsLogRefusalCode =
  | 'agents.log_read_reason_unset'
  | 'agents.log_read_reason_required'
  | 'agents.log_read_reason_unknown'
  | 'agents.ops_actions_limit_unset'
  | 'agents.transcript_retention_unset'
  | 'agents.transcript_not_kept'
  | 'agents.action_not_found'
  | 'agents.log_read_request_reused';

export class OpsLogRefusal extends Error {
  constructor(readonly code: OpsLogRefusalCode) {
    super(code);
    this.name = 'OpsLogRefusal';
  }
}

/** The owner's values for the log. Each null is blank and refuses the read that needs it. */
export interface OpsLogSettings {
  /** AGENTS_LOG_READ_REASONS, split on commas. */
  readonly reasons: readonly string[] | null;
  /** AGENTS_OPS_ACTIONS_LIMIT. */
  readonly limit: number | null;
  /** AGENTS_TRANSCRIPT_RETENTION_DAYS; 0 keeps nothing. */
  readonly retentionDays: number | null;
}

/** The owner's comma-separated reason list; blank, or only commas, is unset. */
export function parseReasons(raw: string | undefined): readonly string[] | null {
  const reasons = (raw ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  return reasons.length > 0 ? [...new Set(reasons)] : null;
}

export const OUTCOMES = ['executed', 'refused', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_WORD: Record<Outcome, string> = { executed: 'Executed', refused: 'Refused', failed: 'Failed' };

/** Checks the reason against the owner's list before anything is read. */
function assertReason(settings: OpsLogSettings, reason: string | undefined): string {
  if (settings.reasons === null) throw new OpsLogRefusal('agents.log_read_reason_unset');
  const picked = reason?.trim() ?? '';
  if (picked === '') throw new OpsLogRefusal('agents.log_read_reason_required');
  if (!settings.reasons.includes(picked)) throw new OpsLogRefusal('agents.log_read_reason_unknown');
  return picked;
}

function assertLimit(settings: OpsLogSettings): number {
  if (settings.limit === null) throw new OpsLogRefusal('agents.ops_actions_limit_unset');
  return settings.limit;
}

const STATUS: Record<OpsLogRefusalCode, TRPCError['code']> = {
  'agents.log_read_reason_unset': 'PRECONDITION_FAILED',
  'agents.log_read_reason_required': 'BAD_REQUEST',
  'agents.log_read_reason_unknown': 'BAD_REQUEST',
  'agents.ops_actions_limit_unset': 'PRECONDITION_FAILED',
  'agents.transcript_retention_unset': 'PRECONDITION_FAILED',
  'agents.transcript_not_kept': 'NOT_FOUND',
  'agents.action_not_found': 'NOT_FOUND',
  'agents.log_read_request_reused': 'CONFLICT',
};

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OpsLogRefusal)) throw err;
    throw new TRPCError({ code: STATUS[err.code], message: err.code, cause: err });
  }
}

function sqlOf(sql: Sql | undefined): Sql {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return sql;
}

type ReadKind = 'actions' | 'export' | 'transcript';

/** One read's business key: a retried request writes no second audit row. */
export const logReadKey = (kind: ReadKind, operatorId: string, requestId: string): string =>
  `agents:logread:${kind}:${operatorId}:${requestId}`;

/**
 * Writes the read's audit row (once per key) and re-reads how many rows carry its key. A key already written for a
 * different customer, reason, filter or action is refused, so a reused request id never reads without its own row.
 */
async function recordRead(
  tx: Sql,
  read: {
    kind: ReadKind;
    operatorId: string;
    requestId: string;
    subjectId: string;
    reason: string;
    filter: Record<string, string>;
    actionId: string | null;
    rowCount: number;
  },
): Promise<number> {
  const key = logReadKey(read.kind, read.operatorId, read.requestId);
  await tx`
    INSERT INTO agents.agent_log_reads (business_key, operator_id, subject_id, kind, reason, filter, action_id, row_count)
    VALUES (${key}, ${read.operatorId}, ${read.subjectId}, ${read.kind}, ${read.reason}, ${tx.json(read.filter)},
            ${read.actionId}, ${read.rowCount})
    ON CONFLICT (business_key) DO NOTHING
  `;
  const rows = await tx<{ subject_id: string; reason: string; filter: Record<string, string>; action_id: string | null }[]>`
    SELECT subject_id, reason, filter, action_id FROM agents.agent_log_reads WHERE business_key = ${key}
  `;
  const same = (row: (typeof rows)[number]): boolean =>
    row.subject_id === read.subjectId &&
    row.reason === read.reason &&
    row.action_id === read.actionId &&
    JSON.stringify(Object.entries(row.filter).sort()) === JSON.stringify(Object.entries(read.filter).sort());
  if (!rows.every(same)) throw new OpsLogRefusal('agents.log_read_request_reused');
  return rows.length;
}

interface ActionRow {
  id: string;
  occurred_at: Date;
  kind: string;
  tool: string | null;
  task: string | null;
  status: Outcome;
  refusal_code: string | null;
  input_digest: string | null;
}

/** The tool a row ran, or the task an engine call ran (an engine call names no tool). */
const toolOf = (row: Pick<ActionRow, 'tool' | 'task'>): string => row.tool ?? row.task ?? '';

async function readActions(
  tx: Sql,
  userId: string,
  filter: { outcome?: Outcome | undefined; tool?: string | undefined },
  limit: number,
): Promise<{ rows: ActionRow[]; more: boolean }> {
  const outcome = filter.outcome ?? null;
  const tool = filter.tool ?? null;
  const rows = await tx<ActionRow[]>`
    SELECT id, occurred_at, kind, tool, task, status, refusal_code, input_digest
      FROM agents.agent_actions
     WHERE user_id = ${userId}
       AND (${outcome}::text IS NULL OR status::text = ${outcome})
       AND (${tool}::text IS NULL OR coalesce(tool, task) = ${tool})
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${limit + 1}
  `;
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

const TOOL_MAX = 120;
const TOOLS_LISTED = 200;

const readInput = z.object({
  userId: z.string().min(1).max(64),
  /** Optional so a missing reason reaches its named refusal, not a schema error. */
  reason: z.string().max(200).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  tool: z.string().min(1).max(TOOL_MAX).optional(),
  requestId: z.string().min(8).max(200),
});

const actionView = z.object({
  id: z.string(),
  occurredAt: z.string(),
  kind: z.string(),
  tool: z.string(),
  outcome: z.enum(OUTCOMES),
  refusalCode: z.string().nullable(),
  inputDigest: z.string().nullable(),
});

const viewOf = (row: ActionRow): z.infer<typeof actionView> => ({
  id: row.id,
  occurredAt: row.occurred_at.toISOString(),
  kind: row.kind,
  tool: toolOf(row),
  outcome: row.status,
  refusalCode: row.refusal_code,
  inputDigest: row.input_digest,
});

const filterOf = (input: z.infer<typeof readInput>): Record<string, string> => ({
  ...(input.outcome ? { outcome: input.outcome } : {}),
  ...(input.tool ? { tool: input.tool } : {}),
});

/** A cell a spreadsheet would run as a formula (a customer's own task string can start with `=`) is read as text. */
const csvCell = (raw: string): string => {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
};

/** The export file: a header, then one line per row, in the order shown. No prompt or answer text. */
export function actionsCsv(rows: readonly z.infer<typeof actionView>[]): string {
  const lines = [['Time', 'Tool', 'Outcome', 'Refusal code', 'Input digest', 'Action id'].join(',')];
  for (const row of rows) {
    lines.push(
      [row.occurredAt, row.tool, OUTCOME_WORD[row.outcome], row.refusalCode ?? '', row.inputDigest ?? '', row.id].map(csvCell).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function opsLogRouter(sql: Sql | undefined, settings: OpsLogSettings) {
  const operator = () => scopedProcedure('admin:read', { module: 'agents' });

  return router({
    /** The reasons an operator may pick, as the owner published them; blank refuses. Reads no log and writes nothing. */
    reasons: operator()
      .output(z.object({ reasons: z.array(z.string()) }))
      .query(() => guard(async () => ({ reasons: [...assertReasonsSet(settings)] }))),

    /** One page of a customer's agent actions, newest first, with the tools they used for the filter. */
    actions: operator()
      .input(readInput)
      .output(
        z.object({
          items: z.array(actionView),
          tools: z.array(z.string()),
          more: z.boolean(),
          limit: z.number().int(),
          auditRows: z.number().int(),
        }),
      )
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const reason = assertReason(settings, input.reason);
          const limit = assertLimit(settings);
          return transaction(sqlOf(sql), async (tx) => {
            const { rows, more } = await readActions(tx, input.userId, input, limit);
            // The filter offers only names it accepts back, and a bounded list of them.
            const tools = await tx<{ tool: string }[]>`
              SELECT DISTINCT coalesce(tool, task) AS tool FROM agents.agent_actions
               WHERE user_id = ${input.userId} AND length(coalesce(tool, task)) BETWEEN 1 AND ${TOOL_MAX}
               ORDER BY 1
               LIMIT ${TOOLS_LISTED}
            `;
            const auditRows = await recordRead(tx, {
              kind: 'actions',
              operatorId: ctx.principal.userId,
              requestId: input.requestId,
              subjectId: input.userId,
              reason,
              filter: filterOf(input),
              actionId: null,
              rowCount: rows.length,
            });
            return { items: rows.map(viewOf), tools: tools.map((t) => t.tool), more, limit, auditRows };
          });
        }),
      ),

    /** The same filter as a file: the rows the list shows for it, as CSV. */
    export: operator()
      .input(readInput)
      .output(z.object({ csv: z.string(), rows: z.number().int(), more: z.boolean(), auditRows: z.number().int() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const reason = assertReason(settings, input.reason);
          const limit = assertLimit(settings);
          return transaction(sqlOf(sql), async (tx) => {
            const { rows, more } = await readActions(tx, input.userId, input, limit);
            const auditRows = await recordRead(tx, {
              kind: 'export',
              operatorId: ctx.principal.userId,
              requestId: input.requestId,
              subjectId: input.userId,
              reason,
              filter: filterOf(input),
              actionId: null,
              rowCount: rows.length,
            });
            return { csv: actionsCsv(rows.map(viewOf)), rows: rows.length, more, auditRows };
          });
        }),
      ),

    /**
     * One engine call's kept prompt text. Refuses before reading when retention is blank, and when the text was not kept
     * (retention 0, expired, or not an engine call). The digest is computed here from the text, never copied.
     */
    transcript: operator()
      .input(
        z.object({
          actionId: z.string().guid(),
          reason: z.string().max(200).optional(),
          requestId: z.string().min(8).max(200),
        }),
      )
      .output(
        z.object({
          actionId: z.string(),
          userId: z.string(),
          text: z.string(),
          digest: z.string(),
          inputDigest: z.string().nullable(),
          storedAt: z.string(),
          expiresAt: z.string(),
          auditRows: z.number().int(),
        }),
      )
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const reason = assertReason(settings, input.reason);
          if (settings.retentionDays === null) throw new OpsLogRefusal('agents.transcript_retention_unset');
          if (settings.retentionDays === 0) throw new OpsLogRefusal('agents.transcript_not_kept');
          return transaction(sqlOf(sql), async (tx) => {
            const [action] = await tx<{ user_id: string; input_digest: string | null }[]>`
              SELECT user_id, input_digest FROM agents.agent_actions WHERE id = ${input.actionId}
            `;
            if (!action) throw new OpsLogRefusal('agents.action_not_found');
            const [kept] = await tx<{ text: string; stored_at: Date; expires_at: Date }[]>`
              SELECT text, stored_at, expires_at FROM agents.agent_transcripts
               WHERE action_id = ${input.actionId} AND expires_at > now()
            `;
            if (!kept) throw new OpsLogRefusal('agents.transcript_not_kept');
            const auditRows = await recordRead(tx, {
              kind: 'transcript',
              operatorId: ctx.principal.userId,
              requestId: input.requestId,
              subjectId: action.user_id,
              reason,
              filter: {},
              actionId: input.actionId,
              rowCount: 1,
            });
            return {
              actionId: input.actionId,
              userId: action.user_id,
              text: kept.text,
              digest: createHash('sha256').update(kept.text).digest('hex'),
              inputDigest: action.input_digest,
              storedAt: kept.stored_at.toISOString(),
              expiresAt: kept.expires_at.toISOString(),
              auditRows,
            };
          });
        }),
      ),
  });
}

function assertReasonsSet(settings: OpsLogSettings): readonly string[] {
  if (settings.reasons === null) throw new OpsLogRefusal('agents.log_read_reason_unset');
  return settings.reasons;
}

/** Deletes every kept transcript past its expiry, whatever retention is now. Returns how many went. */
export async function purgeExpiredTranscripts(sql: Sql): Promise<number> {
  const gone = await sql`DELETE FROM agents.agent_transcripts WHERE expires_at <= now()`;
  return gone.count;
}
