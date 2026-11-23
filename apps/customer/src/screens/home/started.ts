/**
 * "Get started" checklist for a new account (ROADMAP M8): which steps there are, whether each is done, and whether
 * the person has put the list away. Pure logic: the screen reads the real answers (identity, security, the venue's
 * figures for the person's trading account, activity, alerts) and hands them in; nothing here calls a service.
 */
import { HOME_LINKS } from './links';

export type StepId = 'register' | 'verify' | 'secure' | 'deposit' | 'trade' | 'alert';

/**
 * done      the real data says so
 * todo      the real data says not yet
 * review    started and waiting on us (verification submitted, not yet decided)
 * checking  the answer has not arrived yet
 * unknown   the answer could not be read; never shown as done
 */
export type StepStatus = 'done' | 'todo' | 'review' | 'checking' | 'unknown';

export interface Step {
  id: StepId;
  status: StepStatus;
  /** Where the step leads. */
  href: string;
}

export const STEP_ORDER: readonly StepId[] = ['register', 'verify', 'secure', 'deposit', 'trade', 'alert'];

/** Verification: a held level above "none" is done; a submitted record still pending is "in review". */
export function verificationStatus(answer: { tier: string; records: ReadonlyArray<{ status: string }> }): StepStatus {
  if (answer.tier !== 'none') return 'done';
  return answer.records.some((record) => record.status === 'pending') ? 'review' : 'todo';
}

/** Security: one passkey is enough. An authenticator app cannot be read from here (see the PR notes). */
export const securityStatus = (passkeys: number): StepStatus => (passkeys > 0 ? 'done' : 'todo');

/** A price alert the person made: still waiting or already fired. A cancelled one does not count. */
export const alertStatus = (alerts: ReadonlyArray<{ kind: string; status: string }>): StepStatus =>
  alerts.some((alert) => alert.kind === 'price' && alert.status !== 'cancelled') ? 'done' : 'todo';

/**
 * What the venue reports for the person's trading accounts: the venue account each wallet they connected to their
 * INTAFACED account owns (row d115, 17 Nov 2026). INTAFACED's own ledger is never read for this step: the person's money
 * sits at the venue, and only the venue can say a deposit is there (docs/adr/2026-11-10-launch-money-model.md).
 *
 * loading  the answers have not all arrived yet
 * unread   the person's connected wallets could not be read, so no trading account is known
 * read     one entry per connected wallet: the venue's balances for the account it owns, or null where the venue gave
 *          no answer for it (no venue is connected on this deployment, the venue is down, or it refused the read)
 */
export type VenueAccounts =
  | { state: 'loading' }
  | { state: 'unread' }
  | { state: 'read'; accounts: ReadonlyArray<{ balances: ReadonlyArray<{ total: string }> } | null> };

/** A decimal string above zero, read without a float: "0", "0.00", a negative figure and anything malformed hold nothing. */
const holdsMoney = (total: string): boolean => /^[0-9]+(\.[0-9]+)?$/.test(total) && /[1-9]/.test(total);

/**
 * Add money: done once the venue reports a balance in one of the person's trading accounts. With no connected wallet the
 * person has no trading account yet, and with every account read and empty nothing is deposited: both are "to do". An
 * account the venue gave no answer for may hold a deposit, so with no balance read elsewhere the step is unknown, never
 * done and never "to do".
 */
export function depositStatus(venue: VenueAccounts): StepStatus {
  if (venue.state === 'loading') return 'checking';
  if (venue.state === 'unread') return 'unknown';
  if (venue.accounts.some((account) => account?.balances.some((balance) => holdsMoney(balance.total)))) return 'done';
  return venue.accounts.some((account) => account === null) ? 'unknown' : 'todo';
}

/**
 * Whether the money history holds at least one line of a kind, from a kind-filtered read of one line (so an old
 * trade counts however long the history is). `none` also covers a bank that will not read the history of an account
 * that is not verified yet: no money can have moved there.
 */
export type EverRead = 'loading' | 'failed' | 'found' | 'none';

/** First trade: one trade line anywhere in the history. */
export function tradeStatus(history: EverRead): StepStatus {
  return history === 'found' ? 'done' : history === 'none' ? 'todo' : history === 'loading' ? 'checking' : 'unknown';
}

export function buildSteps(statuses: Record<StepId, StepStatus>): Step[] {
  const hrefs: Record<StepId, string> = {
    register: HOME_LINKS.account,
    verify: HOME_LINKS.verification,
    secure: HOME_LINKS.security,
    deposit: HOME_LINKS.deposit,
    trade: HOME_LINKS.firstTrade,
    alert: HOME_LINKS.priceAlert,
  };
  return STEP_ORDER.map((id) => ({ id, status: statuses[id], href: hrefs[id] }));
}

export interface Progress {
  done: number;
  total: number;
  /** Every step is done: the list has nothing left to ask. */
  complete: boolean;
  /** Some answers are still on their way, so a count would be a guess. */
  settled: boolean;
}

export function progress(steps: readonly Step[]): Progress {
  const done = steps.filter((step) => step.status === 'done').length;
  return {
    done,
    total: steps.length,
    complete: steps.length > 0 && done === steps.length,
    settled: steps.every((step) => step.status !== 'checking'),
  };
}

// --- Putting the list away ---------------------------------------------------------------------------------------

export const dismissKey = (userId: string): string => `intafaced.customer.home.started.v1:${userId}`;

/** Per-person, per-browser convenience; a blocked or empty storage simply means "not dismissed". */
export function readDismissed(userId: string | null, storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  if (!userId || !storage) return false;
  try {
    return storage.getItem(dismissKey(userId)) === 'dismissed';
  } catch {
    return false;
  }
}

export function writeDismissed(userId: string | null, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!userId || !storage) return;
  try {
    storage.setItem(dismissKey(userId), 'dismissed');
  } catch {
    // The list stays away for this visit only.
  }
}

/**
 * Whether the list was still open the last time this person's steps were all read on this device. While the steps are
 * being checked, Home draws the list's checking state only if it was open last time, so a finished list doesn't take
 * room at the top and then vanish (a layout jump on phones), and an open one doesn't arrive late and push Home down.
 * A view hint only: it never decides a step. With no hint (the first visit on this device, or blocked storage) the
 * list is drawn while checking, as for a new person; a finished list is then out of the way from the next visit on.
 */
export const lastOpenKey = (userId: string): string => `intafaced.customer.home.started.open.v1:${userId}`;

export function readLastOpen(userId: string | null, storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  if (!userId || !storage) return true;
  try {
    return storage.getItem(lastOpenKey(userId)) !== 'closed';
  } catch {
    return true;
  }
}

export function writeLastOpen(userId: string | null, open: boolean, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!userId || !storage) return;
  try {
    storage.setItem(lastOpenKey(userId), open ? 'open' : 'closed');
  } catch {
    // The hint is only for the next visit's first paint.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
