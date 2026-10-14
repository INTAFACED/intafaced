import { compare, dec, sumOf, toFixedString } from '../../../data/decimal';
import type {
  SampleAgent,
  SampleAgentId,
  SampleAgentMode,
  SampleCheck,
  SampleGuardrails,
  SampleLimits,
  SampleLogEntry,
} from '../../../preview/fixtures/agents';

/**
 * The sums and rules behind the Agents Preview: what the guardrails would decide for a given action, and what the log adds up to.
 * Money is a decimal string or a scaled bigint (data/decimal.ts), never a JS number.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Log entries from the 24 hours before `asOf`, newest first as stored. */
export function lastDay(log: readonly SampleLogEntry[], asOf: string): readonly SampleLogEntry[] {
  const from = Date.parse(asOf) - DAY_MS;
  return log.filter((entry) => Date.parse(entry.at) > from && Date.parse(entry.at) <= Date.parse(asOf));
}

export function actionsBy(log: readonly SampleLogEntry[], agent: SampleAgentId): number {
  return log.filter((entry) => entry.agent === agent).length;
}

export function waiting(log: readonly SampleLogEntry[]): readonly SampleLogEntry[] {
  return log.filter((entry) => entry.result === 'waiting');
}

/** USD an agent has already used in the window: money from actions that were done. */
export function usedBy(log: readonly SampleLogEntry[], agent: SampleAgentId): string {
  return toFixedString(
    sumOf(
      log.filter((entry) => entry.agent === agent && entry.result === 'done' && entry.size !== null).map((entry) => dec(entry.size) ?? 0n),
    ),
    2,
  );
}

export interface Draft {
  readonly mode: SampleAgentMode;
  readonly limits: SampleLimits | null;
  /** Action id to allowed. */
  readonly actions: Readonly<Record<string, boolean>>;
  readonly markets: readonly string[];
}

export function draftOf(guardrails: SampleGuardrails): Draft {
  return {
    mode: guardrails.mode,
    limits: guardrails.limits,
    actions: Object.fromEntries(guardrails.actions.map((rule) => [rule.id, rule.allowed])),
    markets: guardrails.markets,
  };
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type VerdictKind = 'allowed' | 'ask' | 'blocked';
export type VerdictReason = 'action' | 'max' | 'daily' | 'suggest' | 'above' | 'inside' | 'amount' | 'reads';
export interface Verdict {
  readonly kind: VerdictKind;
  readonly reason: VerdictReason;
}

/** What these guardrails would decide for one action. Pure: the same inputs always give the same answer. */
export function judge(input: { agent: SampleAgent; draft: Draft; actionId: string; amount: string; usedToday: string }): Verdict {
  const { agent, draft, actionId, amount, usedToday } = input;
  const rule = agent.guardrails.actions.find((candidate) => candidate.id === actionId);
  if (!rule || draft.actions[actionId] !== true) return { kind: 'blocked', reason: 'action' };
  const limits = draft.limits;
  if (limits === null) return { kind: 'allowed', reason: 'reads' };
  const size = dec(amount);
  if (size === null || size <= 0n) return { kind: 'blocked', reason: 'amount' };
  if (compare(size, dec(limits.maxPerAction) ?? 0n) > 0) return { kind: 'blocked', reason: 'max' };
  const day = (dec(usedToday) ?? 0n) + size;
  if (compare(day, dec(limits.dailyLimit) ?? 0n) > 0) return { kind: 'blocked', reason: 'daily' };
  if (draft.mode === 'suggest') return { kind: 'ask', reason: 'suggest' };
  if (draft.mode === 'ask' && compare(size, dec(limits.askAbove) ?? 0n) > 0) return { kind: 'ask', reason: 'above' };
  return { kind: 'allowed', reason: 'inside' };
}

/** The word for how a logged action was checked, as a key the screen turns into plain text. */
export function checkKey(check: SampleCheck): 'Check inside' | 'Check asked' | 'Check blocked' {
  return check === 'inside' ? 'Check inside' : check === 'asked' ? 'Check asked' : 'Check blocked';
}
