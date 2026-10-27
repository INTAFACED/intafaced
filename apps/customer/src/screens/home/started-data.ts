import { useCallback, useEffect, useMemo, useState } from 'react';
import { z, type ZodType } from 'zod';
import { useSession } from '../../features/session/session';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import type { HomePortfolio, Loadable } from './deps';
import {
  alertStatus,
  buildSteps,
  depositStatus,
  progress,
  readDismissed,
  readLastOpen,
  securityStatus,
  tradeStatus,
  verificationStatus,
  writeDismissed,
  writeLastOpen,
  type EverRead,
  type Step,
  type StepStatus,
} from './started';

// Only the fields the checklist reads. The full screens (Verification, Security, Price alerts) hold the strict
// contracts; here an extra field must not make a done step look undone.
const kycAnswer = z.object({ tier: z.string(), records: z.array(z.object({ status: z.string() }).passthrough()) }).passthrough();
const passkeysAnswer = z.array(z.object({ credentialId: z.string() }).passthrough());
const alertsAnswer = z.object({ items: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()) }).passthrough();
const historyAnswer = z
  .object({ items: z.array(z.object({ id: z.string() }).passthrough()), nextCursor: z.string().nullable().optional() })
  .passthrough();

/** The answer Home already holds; every other step reads its own. */
export interface StartedInputs {
  portfolio: Loadable<HomePortfolio>;
}

/** Money coming in, as the history names it. */
const MONEY_IN = ['deposit', 'welcome_funds', 'transfer_in'] as const;

/**
 * "Not verified yet": no money can have moved in such an account. The tier guard answers `tier.insufficient`; the
 * jurisdiction guard in front of the bank answers a bare FORBIDDEN whose message names the tier, so that message is
 * matched too (any other 403, such as a region block, stays a failure).
 */
const notVerified = (failure: { code?: string; status?: number; message?: string }): boolean =>
  failure.code === 'tier.insufficient' || (failure.status === 403 && /^Verification tier "/.test(failure.message ?? ''));

/**
 * The bank scans a bounded window of the history per call and, when the window holds no match, answers an empty page
 * with a cursor to go on. Following it this many times covers a long history; past that the step is not proven.
 */
const EVER_PAGES = 10;

/** One read of a service answer, only while the list is on screen. */
function useProbe<T>(enabled: boolean, name: string, module: string, procedure: string, input: unknown, schema: ZodType<T>): Resource<T> {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      enabled && userId
        ? api.query(module, procedure, input, schema, { signal })
        : Promise.resolve(authoredRefusal('aborted', { key: 'beforeDispatch' })),
    `started-${name}:${userId}:${enabled}`,
  ).resource;
}

/** "Has a line of these kinds ever been posted": a one-line, kind-filtered read of the history, following the cursor. */
function useEver(enabled: boolean, name: string, filter: { kind: readonly string[]; direction?: 'in' }): Resource<{ found: boolean }> {
  const { api, userId } = useSession();
  return useResource(async (signal): Promise<ApiResult<{ found: boolean }>> => {
    if (!enabled || !userId) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    let cursor: string | undefined;
    for (let page = 0; page < EVER_PAGES; page++) {
      const result = await api.query('bank', 'activity.list', { ...filter, limit: 1, ...(cursor ? { cursor } : {}) }, historyAnswer, {
        signal,
      });
      if (!result.ok) return result;
      if (result.data.items.length > 0) return { ok: true, data: { found: true } };
      if (!result.data.nextCursor) return { ok: true, data: { found: false } };
      cursor = result.data.nextCursor;
    }
    return authoredRefusal('error', { key: 'loadFailed' });
  }, `started-${name}:${userId}:${enabled}`).resource;
}

const fromProbe = <T>(resource: Resource<T>, read: (data: T) => StepStatus): StepStatus =>
  resource.status === 'loading' ? 'checking' : resource.status === 'failed' ? 'unknown' : read(resource.data);

/**
 * "Has this ever happened" from a one-line, kind-filtered read of the money history. The bank refuses (403) the
 * history of an account that is not verified yet; nothing can have moved there, so that refusal reads as "not yet"
 * while verification is not done. Any other failure is unknown, never done.
 */
function ever(resource: Resource<{ found: boolean }>, verify: StepStatus): EverRead {
  if (resource.status === 'loading') return 'loading';
  if (resource.status === 'ready') return resource.data.found ? 'found' : 'none';
  return notVerified(resource.failure) && (verify === 'todo' || verify === 'review') ? 'none' : 'failed';
}

/**
 * The six Get started steps, each from a real record: the session (register), verification, passkeys, the balance and
 * the money history (add money, first trade) and price alerts. Nothing is stored on this device, so clearing the
 * browser changes no step. A read that fails is `unknown`, never `done`.
 */
export function useGetStarted({ portfolio }: StartedInputs, enabled: boolean): Step[] {
  const kyc = useProbe(enabled, 'kyc', 'identity', 'kyc.status', { limit: 10 }, kycAnswer);
  const passkeys = useProbe(enabled, 'passkeys', 'identity', 'webauthn.list', { limit: 10 }, passkeysAnswer);
  const alerts = useProbe(enabled, 'alerts', 'notify', 'notify.alerts', { limit: 100 }, alertsAnswer);
  const moneyIn = useEver(enabled, 'money-in', { kind: MONEY_IN, direction: 'in' });
  const trades = useEver(enabled, 'trade', { kind: ['trade'] });

  return useMemo(() => {
    const verify = fromProbe(kyc, verificationStatus);
    // The bank refuses the balance of an account that is not verified yet. Add money is only "to do" if the history read
    // also proves nothing came in, so the refusal here is read as nothing held.
    const unverified = verify === 'todo' || verify === 'review';
    const balance =
      portfolio.status === 'loading'
        ? 'loading'
        : portfolio.status === 'empty' ||
            (portfolio.status === 'ready' && portfolio.data.holdings.length === 0) ||
            (portfolio.status === 'refused' && unverified)
          ? 'none'
          : portfolio.status === 'ready'
            ? 'held'
            : 'failed';
    return buildSteps({
      // Home is only drawn for a signed-in person: the account exists.
      register: 'done',
      verify,
      secure: fromProbe(passkeys, (data) => securityStatus(data.length)),
      deposit: depositStatus(balance, ever(moneyIn, verify)),
      trade: tradeStatus(ever(trades, verify)),
      alert: fromProbe(alerts, (data) => alertStatus(data.items)),
    });
  }, [kyc, passkeys, alerts, moneyIn, trades, portfolio]);
}

/**
 * The Get started tile on either Home: shown to a signed-in person until every step is done or they hide it (hiding is
 * remembered per person on this device; it is a view choice, not a step). Its reads run unless the person hid it: with
 * no stored tick, only they can tell that every step is still done.
 */
export function useStartedTile(
  portfolio: Loadable<HomePortfolio>,
  /** False while the person has the tile hidden in Customise Home: then nothing is read. */
  allowed = true,
): { show: boolean; steps: Step[]; hide: () => void } {
  const { userId } = useSession();
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  useEffect(() => setDismissed(readDismissed(userId)), [userId]);
  const hide = useCallback(() => {
    writeDismissed(userId);
    setDismissed(true);
  }, [userId]);
  const on = allowed && userId !== null && !dismissed;
  const steps = useGetStarted({ portfolio }, on);
  const { complete, settled } = progress(steps);
  const lastOpen = useMemo(() => readLastOpen(userId), [userId]);
  useEffect(() => {
    if (on && settled) writeLastOpen(userId, !complete);
  }, [on, settled, complete, userId]);
  // until every step is read, draw the list only if it was open last time (readLastOpen)
  return { show: on && !complete && (settled || lastOpen), steps, hide };
}
