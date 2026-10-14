/**
 * What each one-tap action sends to the server, as pure functions. A sheet picks chips; these turn the picks into the exact
 * input a contract expects, or say why they cannot. The caller adds `requestId` (the console reuses it on a retry of the same
 * input) and the current revision.
 *
 * Every limit below is the contract's: reason 500 (a reply's reason 2000), closing evidence 256, next action text 160,
 * commitment evidence 200. Amounts stay exact decimal strings.
 */
import { crmLocalDate } from '@/lib/crm-browser';
import {
  COMMITMENT_EVIDENCE_MAX,
  COMMITMENT_REASON_MAX,
  DECLINE_REASONS,
  LIMITS,
  REPLY_FOLLOW_UP_DAYS_DEFAULT,
  REPLY_NEXT_ACTION_DEFAULT,
  REPLY_REASON_DEFAULT,
  type DeclineReason,
  type Disposition,
} from './policy';
import { parseTypedAmount } from './format';

export type Checked<T> = { ok: true; input: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/* ------------------------------------------------------------------ dates */

/** `days` calendar days from today at 09:00 your time. Calendar days, so a clock change never moves it. */
export function dueAtDays(days: number, now = Date.now()): Date {
  const day = new Date(now);
  day.setDate(day.getDate() + days);
  day.setHours(9, 0, 0, 0);
  return day;
}
/** The same moment as a datetime-local field's value ("2026-10-16T09:00"). */
export const quickDue = (days: number, now = Date.now()) => crmLocalDate(dueAtDays(days, now).toISOString());
/** The same moment as the ISO time the server stores. */
export const dueIso = (days: number, now = Date.now()) => dueAtDays(days, now).toISOString();

/** "14 Oct 2026", in the founder's own calendar. */
export const evidenceDate = (now = Date.now()) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(now));

/** A warning (never a block) when the chosen due time has already passed. */
export function pastDueWarning(due: string, now = Date.now()): string | null {
  const time = due ? new Date(due).getTime() : Number.NaN;
  if (Number.isNaN(time) || time >= now) return null;
  return 'That time has already passed, so this will show as overdue straight away.';
}

/* ------------------------------------------------------------------ mark replied */

export type MarkReplied = {
  opportunityId: string;
  expectedRevision: number;
  kind: 'reply_sent';
  occurredAt: string;
  nextAction: { description: string; dueAt: string };
  reason: string;
};
/** Mark replied with no typing: now, "Replied by email", then "Wait for their reply" due in five days. Chips change any of it. */
export function markRepliedInput(args: {
  opportunityId: string;
  expectedRevision: number;
  now?: number;
  reason?: string;
  description?: string;
  /** Days from today at 09:00. Ignored when `dueAt` is given. */
  days?: number;
  dueAt?: string;
}): Checked<MarkReplied> {
  const now = args.now ?? Date.now();
  const reason = (args.reason ?? REPLY_REASON_DEFAULT).trim();
  const description = (args.description ?? REPLY_NEXT_ACTION_DEFAULT).trim();
  if (!reason) return fail('Pick a reason for the reply.');
  if (reason.length > LIMITS.interactionReason) return fail('That reason is too long.');
  if (!description) return fail('Pick what happens next.');
  if (description.length > LIMITS.nextActionDescription) return fail('That next step is longer than 160 characters.');
  const dueAt = args.dueAt ?? dueIso(args.days ?? REPLY_FOLLOW_UP_DAYS_DEFAULT, now);
  if (Number.isNaN(Date.parse(dueAt))) return fail('Pick when it is due.');
  return {
    ok: true,
    input: {
      opportunityId: args.opportunityId,
      expectedRevision: args.expectedRevision,
      kind: 'reply_sent',
      occurredAt: new Date(now).toISOString(),
      nextAction: { description, dueAt },
      reason,
    },
  };
}

/* ------------------------------------------------------------------ next step, hand over */

export function nextStepInput(args: { opportunityId: string; expectedRevision: number; description: string; due: string }): Checked<{
  opportunityId: string;
  expectedRevision: number;
  description: string;
  dueAt: string;
}> {
  const description = args.description.trim();
  if (!description) return fail('Pick or type what happens next.');
  if (description.length > LIMITS.nextActionDescription) return fail('That next step is longer than 160 characters.');
  const due = new Date(args.due);
  if (!args.due || Number.isNaN(due.getTime())) return fail('Pick when it is due.');
  return {
    ok: true,
    input: { opportunityId: args.opportunityId, expectedRevision: args.expectedRevision, description, dueAt: due.toISOString() },
  };
}

/** The other founder, or null when the two founder names did not both load. */
export function otherFounder<T extends { userId: string }>(owners: readonly T[], ownerUserId: string): T | null {
  if (owners.length !== 2) return null;
  return owners.find((owner) => owner.userId !== ownerUserId) ?? null;
}
export const handOverInput = (args: { opportunityId: string; expectedRevision: number; ownerUserId: string }) => ({
  opportunityId: args.opportunityId,
  expectedRevision: args.expectedRevision,
  ownerUserId: args.ownerUserId,
});

/* ------------------------------------------------------------------ decline and stage */

export const dispositionOf = (reason: DeclineReason): Disposition =>
  DECLINE_REASONS.find((entry) => entry.label === reason)?.disposition ?? 'declined';

/** "Decline reply sent by email on 14 Oct 2026 by Nitro", or, when no email was sent, "Closed without a reply on …". */
export function declineEvidence(args: { now?: number; founder: string | null; sentByEmail: boolean }): string {
  const date = evidenceDate(args.now);
  const by = args.founder ?? 'a founder';
  const text = args.sentByEmail ? `Decline reply sent by email on ${date} by ${by}` : `Closed without a reply on ${date} by ${by}`;
  return text.slice(0, LIMITS.closingEvidence);
}

export type StageChange = {
  opportunityId: string;
  expectedRevision: number;
  stage: string;
  reason: string;
  nextAction: { description: string; dueAt: string } | null;
  closedDisposition: Disposition | null;
  closingEvidenceRef: string | null;
};

/** Closing as a decline: the reason chip decides the outcome, the evidence says whether a reply went out. */
export function declineInput(args: {
  opportunityId: string;
  expectedRevision: number;
  reason: DeclineReason;
  founder: string | null;
  sentByEmail: boolean;
  now?: number;
}): Checked<StageChange> {
  return {
    ok: true,
    input: {
      opportunityId: args.opportunityId,
      expectedRevision: args.expectedRevision,
      stage: 'closed',
      reason: args.reason,
      nextAction: null,
      closedDisposition: dispositionOf(args.reason),
      closingEvidenceRef: declineEvidence({
        founder: args.founder,
        sentByEmail: args.sentByEmail,
        ...(args.now === undefined ? {} : { now: args.now }),
      }),
    },
  };
}

/** Moving the stage. An open stage needs a next action (it starts as the current one); closing needs an outcome and evidence. */
export function stageInput(args: {
  opportunityId: string;
  expectedRevision: number;
  stage: string;
  reason: string;
  actionDescription: string;
  actionDue: string;
  disposition: Disposition;
  evidence: string;
}): Checked<StageChange> {
  const reason = args.reason.trim();
  if (!reason) return fail('Pick a reason.');
  if (reason.length > LIMITS.reason) return fail('That reason is longer than 500 characters.');
  const base = { opportunityId: args.opportunityId, expectedRevision: args.expectedRevision, stage: args.stage, reason };
  if (args.stage === 'closed') {
    const evidence = args.evidence.trim();
    if (!evidence) return fail('Pick or type the evidence for closing.');
    if (evidence.length > LIMITS.closingEvidence) return fail('That evidence is longer than 256 characters.');
    return { ok: true, input: { ...base, nextAction: null, closedDisposition: args.disposition, closingEvidenceRef: evidence } };
  }
  const description = args.actionDescription.trim();
  const due = new Date(args.actionDue);
  if (!description) return fail('Every open stage needs a next step.');
  if (description.length > LIMITS.nextActionDescription) return fail('That next step is longer than 160 characters.');
  if (!args.actionDue || Number.isNaN(due.getTime())) return fail('Pick when the next step is due.');
  return {
    ok: true,
    input: { ...base, nextAction: { description, dueAt: due.toISOString() }, closedDisposition: null, closingEvidenceRef: null },
  };
}

/* ------------------------------------------------------------------ commitment */

export type Tier = 'indicated' | 'soft_circled' | 'committed';
export const TIER_LABEL: Record<Tier, string> = { indicated: 'Indicated', soft_circled: 'Soft-circled', committed: 'Committed' };
export const TIER_HELP: Record<Tier, string> = {
  indicated: 'What they said themselves. Not confirmed by us.',
  soft_circled: 'Confirmed by a founder after a call. Not binding.',
  committed: 'Documents signed. Not money received.',
};
/** A row's tier: its recorded commitment, else Indicated. Only investors can have a commitment. */
export function tierOf(row: { audience: string; commitment?: { tier: 'soft_circled' | 'committed' } | null }): Tier {
  return row.audience === 'investor' && row.commitment ? row.commitment.tier : 'indicated';
}

export type SetCommitment = {
  opportunityId: string;
  expectedRevision: number;
  commitment: { tier: 'soft_circled' | 'committed'; amount: string; currency: string; evidenceRef?: string } | null;
  reason: string;
};
/** Records a tier, or clears it (`tier: 'indicated'`). The amount is read as an exact decimal and never goes through Number. */
export function commitmentInput(args: {
  opportunityId: string;
  expectedRevision: number;
  tier: Tier;
  amount: string;
  currency: string;
  evidence: string;
  reason: string;
}): Checked<SetCommitment> {
  const reason = args.reason.trim();
  if (!reason) return fail('Pick a reason.');
  if (reason.length > COMMITMENT_REASON_MAX) return fail('That reason is longer than 500 characters.');
  const base = { opportunityId: args.opportunityId, expectedRevision: args.expectedRevision, reason };
  if (args.tier === 'indicated') return { ok: true, input: { ...base, commitment: null } };
  const amount = parseTypedAmount(args.amount);
  if (!amount) return fail('Type the amount as a number greater than zero, for example 250000.');
  const currency = args.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return fail('Use a three-letter currency code, for example EUR.');
  const evidence = args.evidence.trim();
  if (evidence.length > COMMITMENT_EVIDENCE_MAX) return fail('That note is longer than 200 characters.');
  return {
    ok: true,
    input: { ...base, commitment: { tier: args.tier, amount, currency, ...(evidence ? { evidenceRef: evidence } : {}) } },
  };
}
