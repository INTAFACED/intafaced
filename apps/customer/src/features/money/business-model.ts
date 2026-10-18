import { decimalSchema, parseAmount } from '../../shared/money';

export type Role = 'admin' | 'maker' | 'checker';
export const ROLES: readonly Role[] = ['admin', 'maker', 'checker'] as const;

export interface ApprovalLike {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  makerUserId: string;
  fromSpaceId: string;
  toSpaceId: string;
}
export type ApprovalAction = 'approve' | 'reject' | 'cancel';

/**
 * What this person may try on an approval. Approving and rejecting are for administrators and checkers; cancelling
 * someone else's proposal is for administrators. With the role unreadable every action is offered and the service
 * decides. A known role removes the buttons it can never use.
 */
export function approvalActions(
  approval: Pick<ApprovalLike, 'status' | 'makerUserId'>,
  me: string | null,
  role: Role | null = null,
): ApprovalAction[] {
  if (approval.status !== 'pending' || !me) return [];
  if (approval.makerUserId === me) return ['cancel'];
  if (role === 'admin' || role === null) return ['approve', 'reject', 'cancel'];
  if (role === 'checker') return ['approve', 'reject'];
  return [];
}

/** A short reference for someone the app cannot name yet (the first block of their id). */
export const shortRef = (id: string): string => id.split('-')[0]!.slice(0, 8);

export type Party = 'you' | 'teammate';
export function whoMade(approval: Pick<ApprovalLike, 'makerUserId'>, me: string | null): Party {
  return me && approval.makerUserId === me ? 'you' : 'teammate';
}

/** Name of one of the customer's own accounts, or null when the account belongs to someone else. */
export function ownSpaceName(spaces: readonly { id: string; name: string }[], id: string): string | null {
  return spaces.find((space) => space.id === id)?.name ?? null;
}

/** The customer's accounts in the company's asset, the only places a company payment can start from or be sent to. */
export function companySpaces<T extends { assetId: string; id: string }>(spaces: readonly T[], assetId: string): T[] {
  return spaces.filter((space) => space.assetId === assetId);
}

/** A company spend threshold must be an exact positive amount; the service refuses zero. */
export function thresholdProblem(value: string): 'invalid' | 'zero' | null {
  if (!decimalSchema.safeParse(value).success) return 'invalid';
  return parseAmount(value) > 0n ? null : 'zero';
}

/** Does this payment need a second person? At or above the threshold, in exact units; below it posts straight away. */
export function needsSecondPerson(amount: string, threshold: string): boolean | null {
  if (!decimalSchema.safeParse(amount).success || !decimalSchema.safeParse(threshold).success) return null;
  return parseAmount(amount) >= parseAmount(threshold);
}

/**
 * The reply to a payment proposal must be the one that was asked for. Pending: the approval carries the request id,
 * the same account, accounts and amount to the digit. Posted: a ledger transaction exists.
 */
export function proposalMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const reply = data as Record<string, unknown>;
  if (reply.kind === 'posted') return typeof reply.ledgerTxId === 'string' && reply.ledgerTxId.trim().length > 0;
  if (reply.kind !== 'pending' || !reply.approval || typeof reply.approval !== 'object') return false;
  const approval = reply.approval as Record<string, unknown>;
  return (
    typeof approval.id === 'string' &&
    typeof input.clientId === 'string' &&
    approval.id.toLowerCase() === input.clientId.toLowerCase() &&
    approval.accountId === input.accountId &&
    approval.fromSpaceId === input.fromSpaceId &&
    approval.toSpaceId === input.toSpaceId &&
    typeof approval.amount === 'string' &&
    typeof input.amount === 'string' &&
    decimalSchema.safeParse(approval.amount).success &&
    parseAmount(approval.amount) === parseAmount(input.amount)
  );
}

/** Which of the two outcomes a proposal reply was, in words the screen can pick copy for. */
export function proposalOutcome(data: unknown): 'pending' | 'posted' | null {
  const kind = data && typeof data === 'object' ? (data as Record<string, unknown>).kind : null;
  return kind === 'pending' || kind === 'posted' ? kind : null;
}

/** Who can propose a payment or run a payroll: administrators and makers. A checker only decides on payments. */
export function canSend(role: Role | null): boolean {
  return role === 'admin' || role === 'maker';
}
export const canRunPayroll = canSend;

/** What someone typed to find a person: a handle (with or without "@") or an email. Never both, never a guess. */
export type RecipientQuery = { handle: string } | { email: string };
const HANDLE = /^[a-zA-Z0-9_]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function recipientQuery(text: string): RecipientQuery | null {
  const typed = text.trim();
  if (typed === '') return null;
  if (!typed.startsWith('@') && typed.includes('@')) return typed.length <= 320 && EMAIL.test(typed) ? { email: typed } : null;
  const handle = typed.startsWith('@') ? typed.slice(1) : typed;
  return HANDLE.test(handle) ? { handle } : null;
}

export const MAX_PAYROLL_LINES = 64;
/** One person to pay: who they are, the main account of theirs the service found, and the exact amount. */
export type PayrollLine = { handle: string; toSpaceId: string; amount: string };

export type PayrollProblem = 'empty' | 'tooMany' | 'amount' | 'duplicate' | 'source' | 'overLimit' | 'overBalance';

/** The sum of the lines in exact units, or null when a line is not an exact decimal. */
export function payrollTotal(lines: readonly Pick<PayrollLine, 'amount'>[]): bigint | null {
  let total = 0n;
  for (const line of lines) {
    if (!decimalSchema.safeParse(line.amount).success) return null;
    total += parseAmount(line.amount);
  }
  return total;
}

/**
 * The first reason a payroll cannot go out, using the same rules the bank applies: at least one and at most 64 people,
 * every amount above zero, nobody twice and not the source account, and a total strictly below the approval limit,
 * because a payroll has no second approver. The balance is checked here so the review never promises more than is held.
 */
export function payrollProblem(input: {
  lines: readonly PayrollLine[];
  fromSpaceId: string;
  threshold: string;
  balance: string | null;
}): PayrollProblem | null {
  const { lines } = input;
  if (lines.length === 0) return 'empty';
  if (lines.length > MAX_PAYROLL_LINES) return 'tooMany';
  const total = payrollTotal(lines);
  if (total === null || lines.some((line) => parseAmount(line.amount) <= 0n)) return 'amount';
  const seen = new Set<string>([input.fromSpaceId.toLowerCase()]);
  for (const line of lines) {
    const id = line.toSpaceId.toLowerCase();
    if (seen.has(id)) return id === input.fromSpaceId.toLowerCase() ? 'source' : 'duplicate';
    seen.add(id);
  }
  if (decimalSchema.safeParse(input.threshold).success && total >= parseAmount(input.threshold)) return 'overLimit';
  if (input.balance !== null && decimalSchema.safeParse(input.balance).success && total > parseAmount(input.balance)) return 'overBalance';
  return null;
}

/** The exact request for `business.runPayroll`. The request id is the payroll id, so a resend is the same payroll. */
export function buildPayrollInput(payrollId: string, accountId: string, fromSpaceId: string, lines: readonly PayrollLine[]) {
  return {
    payrollId,
    accountId,
    fromSpaceId,
    recipients: lines.map((line) => ({ toSpaceId: line.toSpaceId, amount: line.amount.trim() })),
  };
}

/** The reply must be the payroll that was reviewed: same id, account, source and the same people and amounts to the digit. */
export function payrollMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const run = data as Record<string, unknown>;
  const sent = Array.isArray(input.recipients) ? (input.recipients as Array<Record<string, unknown>>) : null;
  const got = Array.isArray(run.recipients) ? (run.recipients as Array<Record<string, unknown>>) : null;
  if (
    !sent ||
    !got ||
    typeof run.payrollId !== 'string' ||
    typeof input.payrollId !== 'string' ||
    run.payrollId.toLowerCase() !== input.payrollId.toLowerCase() ||
    run.accountId !== input.accountId ||
    run.fromSpaceId !== input.fromSpaceId ||
    typeof run.ledgerTxId !== 'string' ||
    run.ledgerTxId.trim() === '' ||
    sent.length !== got.length
  )
    return false;
  const paid = new Map(got.map((row) => [String(row.toSpaceId).toLowerCase(), row.amount] as const));
  return (
    paid.size === got.length &&
    sent.every((row) => {
      const amount = paid.get(String(row.toSpaceId).toLowerCase());
      return (
        typeof amount === 'string' &&
        typeof row.amount === 'string' &&
        decimalSchema.safeParse(amount).success &&
        decimalSchema.safeParse(row.amount).success &&
        parseAmount(amount) === parseAmount(row.amount)
      );
    })
  );
}

/** The team's roles in the customer's words key, so the screen never prints the service's raw role name. */
export const ROLE_KEY: Record<Role, 'roleAdmin' | 'roleMaker' | 'roleChecker'> = {
  admin: 'roleAdmin',
  maker: 'roleMaker',
  checker: 'roleChecker',
};

/** The reply to a role change must name that person with the role that was reviewed. */
export function roleChangeMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const reply = data as Record<string, unknown>;
  return reply.accountId === input.accountId && reply.userId === input.userId && reply.role === input.role;
}

/** The reply to a removal must say that person was removed from that team. */
export function removalMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const reply = data as Record<string, unknown>;
  return reply.accountId === input.accountId && reply.userId === input.userId && reply.removed === true;
}
