import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  ownAgentNoValueReviewSchema,
  ownAgentValueReviewSchema,
  type OwnAgentAssistant,
  type OwnAgentReview,
  type OwnAgentReviewer,
  type OwnAgentReviewRow,
} from '@intafaced/contracts/agents-own';
import { OWN_TOOLS, OwnAgentRefusal } from './catalog.js';
import { ASSISTANT_TEST_ENGINE } from './assistant.js';

/**
 * THE AUTOMATIC REVIEWER (AG-approvals-02; J-agents-05 #7).
 *
 * A switch per agent lets the person send the calls their rules would hold for them to a reviewer instead. The reviewer
 * stands between the guardrail's "ask" and the person, and it can only add friction (ENGINE AP-7):
 * - `proceed` runs the held call once, as an approval would, on the request's own key;
 * - `needs_person` holds the call for the person, as with the switch off;
 * - `refuse` ends the call with `agents.review_refused` and its coded reason, and nothing runs.
 * It never lifts a refusal of the gates before it (consent, baseline, rule, the session's guardrail): it is only asked
 * once they have said "ask". For a tool that can move value `proceed` is not in the answer's schema, so the call goes
 * to the person, and the reviewer is not asked at all.
 *
 * The reviewer runs on the model the owner chose (`AGENTS_REVIEWER_MODEL`). Blank: the owner has not chosen, and every
 * call goes to the person (`owner.decision`). `test-engine` (a test deployment only) is the TEST engine: it reviews by
 * rule from the call's input and calls no model, so it is billed nothing. Any other model has no review adapter yet:
 * every call goes to the person with `agents.review.engine_unavailable`. The call's input is untrusted content (ENGINE
 * UC-1): text in it that tells the reviewer what to decide is a reason to refuse, never an instruction it follows.
 *
 * A decision is stored once per call, `agents:review:<session>:<request id>`, with its reason as a code and the input as
 * a digest, never its text; a retried call reads the stored decision and is never reviewed again. Nothing moves value.
 */

export type ReviewEngine = OwnAgentAssistant['engine'];

export function reviewerEngine(model: string | null | undefined): ReviewEngine {
  const value = model?.trim() ?? '';
  if (!value) return null;
  return value === ASSISTANT_TEST_ENGINE ? 'test' : 'live';
}

/** Whether a tool can move value: a money tool of the catalogue, or a tool the catalogue does not know (fail closed). */
export function canMoveValue(tool: string): boolean {
  const entry = OWN_TOOLS.find((row) => row.name === tool);
  return !entry || entry.movesMoney;
}

/**
 * Words in a call's input that try to steer whoever decides on it. The TEST engine refuses such a call: an input that
 * argues for its own approval is the case a reviewer exists to stop.
 */
const STEERING =
  /\b(ignore|disregard|override|bypass)\b[\s\S]{0,200}?\b(rules?|instructions?|reviewer|checks?)\b|\bapprove (this|me|it)\b/i;

/** The TEST engine's raw answer for a call: by rule from its input, no model called. */
function testEngineAnswer(args: Readonly<Record<string, string>>): { decision: string; reasonCode: string } {
  if (Object.values(args).some((value) => STEERING.test(value))) {
    return { decision: 'refuse', reasonCode: 'agents.review.instruction_in_input' };
  }
  return { decision: 'proceed', reasonCode: 'agents.review.no_value_effect' };
}

/**
 * The reviewer's decision on one call. A tool that can move value goes to the person without asking the engine; a
 * blank model goes to the person with `owner.decision`; the engine's raw answer is read through the schema for the
 * tool's kind, so an answer the schema has no room for (`proceed` for a value tool, anything malformed) goes to the
 * person with `agents.review.answer_invalid`.
 */
export function reviewCall(
  engine: ReviewEngine,
  call: { tool: string; input: Readonly<Record<string, string>> },
  answer: (args: Readonly<Record<string, string>>) => unknown = testEngineAnswer,
): OwnAgentReview {
  const valueTool = canMoveValue(call.tool);
  if (valueTool) return { valueTool: true, decision: 'needs_person', reasonCode: 'agents.review.value_tool' };
  if (engine === null) return { valueTool: false, decision: 'needs_person', reasonCode: 'owner.decision' };
  if (engine === 'live') return { valueTool: false, decision: 'needs_person', reasonCode: 'agents.review.engine_unavailable' };
  return readAnswer(valueTool, answer(call.input));
}

/** An engine's raw answer through the schema for the tool's kind; anything it has no room for goes to the person. */
export function readAnswer(valueTool: boolean, raw: unknown): OwnAgentReview {
  const parsed = (valueTool ? ownAgentValueReviewSchema : ownAgentNoValueReviewSchema).safeParse({
    ...(raw && typeof raw === 'object' ? raw : {}),
    valueTool,
  });
  if (parsed.success) return parsed.data;
  return valueTool
    ? { valueTool: true, decision: 'needs_person', reasonCode: 'agents.review.answer_invalid' }
    : { valueTool: false, decision: 'needs_person', reasonCode: 'agents.review.answer_invalid' };
}

/** The call's input as a digest: the stored decision names what it decided on without keeping the text. */
export function inputDigest(tool: string, args: Readonly<Record<string, string>>): string {
  // Code-unit order, the same on every runtime and locale.
  const sorted = Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([tool, sorted]))
    .digest('hex')}`;
}

interface SettingRow {
  enabled: boolean;
  updated_at: Date;
}
interface ReviewRow {
  id: string;
  session_id: string;
  request_id: string;
  tool: string;
  decision: OwnAgentReviewRow['decision'];
  reason_code: string;
  input_digest: string;
  approval_request_id: string | null;
  engine: OwnAgentReviewRow['engine'];
  created_at: Date;
}
const reviewView = (row: ReviewRow): OwnAgentReviewRow => ({
  id: row.id,
  sessionId: row.session_id,
  requestId: row.request_id,
  tool: row.tool,
  decision: row.decision,
  reasonCode: row.reason_code,
  inputDigest: row.input_digest,
  approvalRequestId: row.approval_request_id,
  engine: row.engine,
  createdAt: row.created_at.toISOString(),
});

/** The person's reviewer switch per agent, and the reviewer's stored decisions. */
export class OwnReviewerStore {
  constructor(private readonly sql: Sql) {}

  async setting(ownerId: string, agentId: string, engine: ReviewEngine): Promise<OwnAgentReviewer> {
    const [row] = await this.sql<SettingRow[]>`
      SELECT enabled, updated_at FROM agents.own_agent_reviewer_settings WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
    `;
    return { on: row?.enabled ?? false, engine, updatedAt: row?.updated_at.toISOString() ?? null };
  }

  async set(ownerId: string, agentId: string, on: boolean, engine: ReviewEngine): Promise<OwnAgentReviewer> {
    const [row] = await this.sql<SettingRow[]>`
      INSERT INTO agents.own_agent_reviewer_settings (owner_id, agent_id, enabled)
      VALUES (${ownerId}, ${agentId}, ${on})
      ON CONFLICT (owner_id, agent_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      RETURNING enabled, updated_at
    `;
    return { on: row!.enabled, engine, updatedAt: row!.updated_at.toISOString() };
  }

  private readonly columns = () => this.sql`
    id::text AS id, session_id::text AS session_id, request_id, tool, decision, reason_code, input_digest,
    approval_request_id::text AS approval_request_id, engine, created_at
  `;

  /**
   * The stored decision on this call, if any. The same request id for another tool or input refuses
   * `agents.request_id_replay`: a request id is one call.
   */
  async find(
    ownerId: string,
    sessionId: string,
    requestId: string,
    call: { tool: string; input: Readonly<Record<string, string>> },
  ): Promise<OwnAgentReviewRow | null> {
    const [row] = await this.sql<ReviewRow[]>`
      SELECT ${this.columns()} FROM agents.own_agent_reviews
       WHERE owner_id = ${ownerId} AND idempotency_key = ${reviewKey(sessionId, requestId)}
    `;
    if (!row) return null;
    if (row.tool !== call.tool || row.input_digest !== inputDigest(call.tool, call.input)) {
      throw new OwnAgentRefusal('agents.request_id_replay');
    }
    return reviewView(row);
  }

  /** Stores the decision once; a second store of the same call returns the first. */
  async record(input: {
    ownerId: string;
    agentId: string;
    sessionId: string;
    requestId: string;
    tool: string;
    args: Readonly<Record<string, string>>;
    review: OwnAgentReview;
    engine: ReviewEngine;
  }): Promise<OwnAgentReviewRow> {
    const key = reviewKey(input.sessionId, input.requestId);
    await this.sql`
      INSERT INTO agents.own_agent_reviews
        (owner_id, agent_id, session_id, request_id, idempotency_key, tool, decision, reason_code, input_digest, engine)
      VALUES (${input.ownerId}, ${input.agentId}, ${input.sessionId}, ${input.requestId}, ${key}, ${input.tool},
              ${input.review.decision}, ${input.review.reasonCode}, ${inputDigest(input.tool, input.args)}, ${input.engine})
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING
    `;
    const stored = await this.find(input.ownerId, input.sessionId, input.requestId, { tool: input.tool, input: input.args });
    return stored!;
  }

  /** Names the approval request the call became, once. */
  async link(ownerId: string, id: string, approvalRequestId: string): Promise<void> {
    await this.sql`
      UPDATE agents.own_agent_reviews SET approval_request_id = ${approvalRequestId}
       WHERE owner_id = ${ownerId} AND id = ${id} AND approval_request_id IS NULL
    `;
  }

  async list(ownerId: string, agentId: string, limit: number): Promise<OwnAgentReviewRow[]> {
    const rows = await this.sql<ReviewRow[]>`
      SELECT ${this.columns()} FROM agents.own_agent_reviews
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}
    `;
    return rows.map(reviewView);
  }
}

export const reviewKey = (sessionId: string, requestId: string) => `agents:review:${sessionId}:${requestId}`;
