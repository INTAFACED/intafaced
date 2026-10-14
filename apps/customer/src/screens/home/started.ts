/**
 * "Get started" checklist for a new account (ROADMAP M8): which steps there are, whether each is done, and whether
 * the person has put the list away. Pure logic: the screen reads the real answers (identity, security, balances,
 * activity, alerts) and hands them in; nothing here calls a service.
 */
import type { ActivityItem } from './deps';
import { HOME_LINKS } from './links';

export type StepId = 'verify' | 'secure' | 'deposit' | 'trade' | 'alert';

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
  /** Where the step leads, or null when there is nowhere live to send the person yet. */
  href: string | null;
}

export const STEP_ORDER: readonly StepId[] = ['verify', 'secure', 'deposit', 'trade', 'alert'];

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

const MONEY_IN = new Set<ActivityItem['kind']>(['deposit', 'welcome_funds', 'transfer_in']);
export const hasMoneyIn = (items: readonly ActivityItem[]): boolean =>
  items.some((item) => MONEY_IN.has(item.kind) && item.direction === 'in');
export const hasTrade = (items: readonly ActivityItem[]): boolean => items.some((item) => item.kind === 'trade');

/**
 * Add money: done when the account holds anything now, or ever received money (a person who moved everything out
 * has still added money once). While the balance is loading nothing is claimed.
 */
export function depositStatus(balance: 'loading' | 'failed' | 'held' | 'none', history: 'loading' | 'failed' | 'in' | 'none'): StepStatus {
  if (balance === 'held' || history === 'in') return 'done';
  if (balance === 'loading' || (balance === 'none' && history === 'loading')) return 'checking';
  if (balance === 'none' && history === 'none') return 'todo';
  return 'unknown';
}

/** First trade, from the money history (newest first). More pages are read until a trade turns up or the cap is hit. */
export function tradeStatus(history: 'loading' | 'failed' | 'empty' | { trade: boolean; hasMore: boolean; read: number }): StepStatus {
  if (history === 'loading') return 'checking';
  if (history === 'failed') return 'unknown';
  if (history === 'empty') return 'todo';
  if (history.trade) return 'done';
  return history.hasMore && history.read < PAGES_CAP ? 'checking' : 'todo';
}
/** How many history rows are read looking for a first trade before the answer is "not yet". */
export const PAGES_CAP = 250;

export function buildSteps(statuses: Record<StepId, StepStatus>): Step[] {
  const hrefs: Record<StepId, string | null> = {
    verify: HOME_LINKS.verification,
    secure: HOME_LINKS.security,
    deposit: HOME_LINKS.deposit,
    trade: HOME_LINKS.firstTrade,
    alert: HOME_LINKS.priceAlert,
  };
  return STEP_ORDER.map((id) => ({ id, status: statuses[id], href: hrefs[id] }));
}

/** A step with nowhere live to go can still show done, but cannot be asked of the person. */
export const isAvailable = (step: Step): boolean => step.href !== null || step.status === 'done';

export interface Progress {
  done: number;
  total: number;
  /** Every available step is done: the list can say "all set". */
  complete: boolean;
  /** Some answers are still on their way, so a count would be a guess. */
  settled: boolean;
}

export function progress(steps: readonly Step[]): Progress {
  const asked = steps.filter(isAvailable);
  const done = asked.filter((step) => step.status === 'done').length;
  return {
    done,
    total: asked.length,
    complete: asked.length > 0 && done === asked.length,
    settled: asked.every((step) => step.status !== 'checking'),
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

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
