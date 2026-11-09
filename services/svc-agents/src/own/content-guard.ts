import type { OwnAgentTestGuard, OwnAgentValuePayload } from '@intafaced/contracts/agents-own';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { OwnAgentRefusal } from './catalog.js';
import { testEngineReply } from './evaluations.js';

/**
 * HOSTILE CONTENT AND OUTPUT GUARDS ON A TEST RUN OF A PERSON'S OWN AGENT (AG-guardrails-03; J-agents-10 #1, #2, #3).
 *
 * Agentic law (DEFINITIVE_BUILD section 8.2): text the agent reads from outside (a page, a message, a file) is data,
 * never an instruction. Three rules follow, and each is enforced here, on the service, not in the screen:
 *
 * 1. Outside content is always labelled untrusted. Content that tries to give the agent instructions (ignore your
 *    instructions, you are now, send all funds) blocks the step with `agents.content.untrusted`: nothing runs, no reply
 *    is kept and the charge is 0. A value instruction that comes only from outside content blocks the same way: nobody
 *    asked for it, so there is nothing to approve.
 * 2. An action that moves value takes its amount, asset and destination only from the payload the person approves,
 *    which is read from the person's own words. The step the engine drafts is compared with the approved payload when the
 *    person approves; any difference refuses `agents.payload.mismatch` and nothing is sent.
 * 3. An output schema, when the person sets one, is checked against the reply before it is shown; a reply that fails it
 *    is withheld and refused `agents.output.blocked`.
 *
 * The test engine is the deterministic stand-in (no model): when the outside content carries a value instruction, the
 * step it drafts copies that instruction's arguments, as a hijacked engine would. That is the worst case the rule must
 * survive, so the test shows it. A test run never moves value whatever the outcome: the person's own agent carries no
 * tool that moves money (`agents.own.money_tool`), no session is opened and no ledger call is made.
 */

/** Phrases by which outside content tries to instruct the agent rather than inform it. */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(instructions?|rules?|prompts?|guardrails?|polic(y|ies)|limits?)\b/i,
  /\byou are now\b/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\b(send|transfer|move|withdraw|pay)\s+(all|every|the whole|your entire)\b[^.!?\n]{0,20}\b(funds?|money|balances?|assets?|coins?|crypto)\b/i,
  /\bdo not (tell|inform|ask) (the )?(user|person|owner)\b/i,
];

/** A value instruction in words: send / pay / transfer / move <amount> <asset> to <destination>. */
const VALUE_INSTRUCTION = /\b(?:send|pay|transfer|move)\s+([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9]{1,11})\s+to\s+([^\n.!?;]{1,120})/i;

/** Outside content as long as a test run stores it. */
export const OUTSIDE_CONTENT_MAX = 8000;
/** An output schema as long as a test run stores it. */
export const OUTPUT_SCHEMA_MAX = 4000;

/** Whether outside content tries to instruct the agent. */
export const triesToInstruct = (content: string): boolean => INSTRUCTION_PATTERNS.some((pattern) => pattern.test(content));

/** The value instruction a text carries, canonical, or null when it carries none (or one with no valid amount). */
export function valueInstruction(text: string): OwnAgentValuePayload | null {
  const found = VALUE_INSTRUCTION.exec(text);
  if (!found) return null;
  let amount: string;
  try {
    const units = parseAmount(found[1]!);
    if (units <= 0n) return null;
    amount = formatAmount(units);
  } catch {
    return null;
  }
  const destination = found[3]!.trim().replace(/\s+/g, ' ');
  if (!destination) return null;
  return { amount, assetId: found[2]!.toUpperCase(), destination };
}

/** Whether two payloads are the same amount, asset and destination. */
export const samePayload = (a: OwnAgentValuePayload, b: OwnAgentValuePayload): boolean =>
  parseAmount(a.amount) === parseAmount(b.amount) && a.assetId === b.assetId && a.destination === b.destination;

const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
type SchemaType = (typeof SCHEMA_TYPES)[number];
/** Keys of an output schema that describe it without constraining it. */
const SCHEMA_WORDS = new Set(['$schema', 'title', 'description']);

/**
 * An output schema as the person typed it: a JSON object holding `type` (one of the JSON types, or a list of them) and
 * nothing else that constrains. Anything the guard cannot check is refused by name rather than half-checked.
 */
export function readOutputSchema(text: string): readonly SchemaType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OwnAgentRefusal('agents.output.schema_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OwnAgentRefusal('agents.output.schema_invalid');
  const schema = parsed as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (key !== 'type' && !SCHEMA_WORDS.has(key)) throw new OwnAgentRefusal('agents.output.schema_unsupported', { keyword: key });
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0 || !types.every((type): type is SchemaType => SCHEMA_TYPES.includes(type as SchemaType))) {
    throw new OwnAgentRefusal('agents.output.schema_invalid');
  }
  return types;
}

/** The JSON type of a reply: the reply read as JSON when it is JSON, otherwise a string. */
function replyTypes(reply: string): SchemaType[] {
  let value: unknown = reply;
  try {
    value = JSON.parse(reply);
  } catch {
    // Not JSON: the reply is text.
  }
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'number') return Number.isInteger(value) ? ['integer', 'number'] : ['number'];
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'object') return [typeof value as SchemaType];
  return [];
}

/** Whether a reply meets the output schema's types. */
export const meetsOutputSchema = (reply: string, types: readonly SchemaType[]): boolean =>
  replyTypes(reply).some((type) => types.includes(type));

/** What a guarded test run decided: the guard as shown, the reply kept (empty when nothing may be shown) and the drafted step. */
export type GuardedRun = {
  readonly guard: OwnAgentTestGuard;
  readonly reply: string;
  /** The value-moving step the engine drafted, kept on the service and compared at approval; never shown. */
  readonly drafted: OwnAgentValuePayload | null;
};

/**
 * One test engine run under the guards. `content` is the outside content the agent reads (null when none), `outputSchema`
 * the schema its reply must meet (null when none). Refuses by name only for what the person typed wrong (a schema it
 * cannot read); everything the guards decide is a stored outcome, so the run and its charge of 0 are on record.
 */
export function guardedEngineRun(input: { ask: string; content: string | null; outputSchema: string | null }): GuardedRun {
  const schema = input.outputSchema === null ? null : readOutputSchema(input.outputSchema);
  const base = { content: input.content === null ? null : { trust: 'untrusted' as const }, approval: null };
  const blocked = (code: string): GuardedRun => ({ guard: { ...base, outcome: 'blocked', code }, reply: '', drafted: null });

  const fromContent = input.content === null ? null : valueInstruction(input.content);
  if (input.content !== null && triesToInstruct(input.content)) return blocked('agents.content.untrusted');
  const asked = valueInstruction(input.ask);
  // A value instruction only outside content gives: nobody asked for it, so nothing is drafted and nothing waits.
  if (fromContent && !asked) return blocked('agents.content.untrusted');

  const reply = testEngineReply(input.ask);
  if (schema && !meetsOutputSchema(reply, schema)) return blocked('agents.output.blocked');
  if (asked) {
    // The approval request carries the person's own words only; the drafted step is what the engine would send.
    return {
      guard: { ...base, outcome: 'awaiting_approval', code: null, approval: asked },
      reply,
      drafted: fromContent ?? asked,
    };
  }
  return { guard: { ...base, outcome: 'answered', code: null }, reply, drafted: null };
}

/**
 * The person's decision on a guarded run's approval request. Only the approved payload counts: it must be the request's
 * payload exactly, and the step the engine drafted must match it, or the step refuses `agents.payload.mismatch`. A match
 * is approved and still sends nothing: a test run moves no value and the person's own agent carries no money tool.
 */
export function decideApproval(
  guard: OwnAgentTestGuard,
  drafted: OwnAgentValuePayload | null,
  approved: OwnAgentValuePayload,
): OwnAgentTestGuard {
  if (guard.outcome !== 'awaiting_approval' || !guard.approval) throw new OwnAgentRefusal('agents.test.no_approval_waiting');
  const matches = samePayload(guard.approval, approved) && drafted !== null && samePayload(drafted, guard.approval);
  return matches
    ? { ...guard, outcome: 'approved', code: null }
    : { ...guard, outcome: 'payload_refused', code: 'agents.payload.mismatch' };
}
