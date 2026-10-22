import { useCallback, useEffect, useMemo, useState } from 'react';
import { z, type ZodType } from 'zod';
import { useSession } from '../../features/session/session';
import { authoredRefusal } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import type { HomePortfolio, Loadable } from './deps';
import {
  alertStatus,
  buildSteps,
  depositStatus,
  progress,
  readDismissed,
  securityStatus,
  tradeStatus,
  verificationStatus,
  writeDismissed,
  type EverRead,
  type Step,
  type StepStatus,
} from './started';

// Only the fields the checklist reads. The full screens (Verification, Security, Price alerts) hold the strict
// contracts; here an extra field must not make a done step look undone.
const kycAnswer = z.object({ tier: z.string(), records: z.array(z.object({ status: z.string() }).passthrough()) }).passthrough();
const passkeysAnswer = z.array(z.object({ credentialId: z.string() }).passthrough());
const alertsAnswer = z.object({ items: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()) }).passthrough();
const historyAnswer = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

/** The answer Home already holds; every other step reads its own. */
export interface StartedInputs {
  portfolio: Loadable<HomePortfolio>;
}

/** Money coming in, as the history names it. */
const MONEY_IN = ['deposit', 'welcome_funds', 'transfer_in'] as const;

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

const fromProbe = <T>(resource: Resource<T>, read: (data: T) => StepStatus): StepStatus =>
  resource.status === 'loading' ? 'checking' : resource.status === 'failed' ? 'unknown' : read(resource.data);

/**
 * "Has this ever happened" from a one-line, kind-filtered read of the money history. The bank refuses (403) the
 * history of an account that is not verified yet; nothing can have moved there, so that refusal reads as "not yet"
 * while verification is not done. Any other failure is unknown, never done.
 */
function ever(resource: Resource<z.infer<typeof historyAnswer>>, verify: StepStatus): EverRead {
  if (resource.status === 'loading') return 'loading';
  if (resource.status === 'ready') return resource.data.items.length > 0 ? 'found' : 'none';
  return resource.failure.status === 403 && (verify === 'todo' || verify === 'review') ? 'none' : 'failed';
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
  const moneyIn = useProbe(enabled, 'money-in', 'bank', 'activity.list', { kind: MONEY_IN, limit: 1 }, historyAnswer);
  const trades = useProbe(enabled, 'trade', 'bank', 'activity.list', { kind: ['trade'], limit: 1 }, historyAnswer);

  return useMemo(() => {
    const verify = fromProbe(kyc, verificationStatus);
    // As with the history, the bank refuses the balance of an account that is not verified yet: nothing is held there.
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
 * remembered per person on this device; it is a view choice, not a step). Its reads run only while it can show.
 */
export function useStartedTile(portfolio: Loadable<HomePortfolio>): { show: boolean; steps: Step[]; hide: () => void } {
  const { userId } = useSession();
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  useEffect(() => setDismissed(readDismissed(userId)), [userId]);
  const hide = useCallback(() => {
    writeDismissed(userId);
    setDismissed(true);
  }, [userId]);
  const on = userId !== null && !dismissed;
  const steps = useGetStarted({ portfolio }, on);
  return { show: on && !progress(steps).complete, steps, hide };
}
