import { useCallback, useEffect, useMemo, useState } from 'react';
import { startedPasskeysSchema } from '@intafaced/contracts/started-checklist-reads';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import type { ZodType } from 'zod';
import { NOTIFY_ALERTS } from '@intafaced/contracts/notify-notify-procedures';
import type { ProcedureInput, ProcedureOutput } from '@intafaced/contracts/procedure';
import { PROTOCOL_VENUE_WALLET_STATUS } from '@intafaced/contracts/protocol-wallet-procedures';
import { useSession } from '../../features/session/session';
import { venueApi } from '../../features/trade';
import { authoredRefusal, isVerifyFirst, type ApiResult, type AppProcedure } from '../../shared/api';
import type { UiMessage } from '../../shared/ui-copy';
import { useResource, type Resource } from '../../shared/resource';
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
  type VenueAccounts,
} from './started';
import { BANK_ACTIVITY_LIST, type ACTIVITY_KINDS } from '@intafaced/contracts/bank-activity-procedures';

type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * "Not verified yet": no money can have moved in such an account. The tier guard answers `tier.insufficient`; the
 * jurisdiction guard in front of the bank answers a bare FORBIDDEN whose message names the tier, so that message is
 * matched too (any other 403, such as a region block, stays a failure).
 */
const notVerified = (failure: { code?: string; status?: number; message?: string; messageCopy?: UiMessage }): boolean =>
  failure.code === 'tier.insufficient' ||
  isVerifyFirst(failure) ||
  (failure.status === 403 && /^Verification tier "/.test(failure.message ?? ''));

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

/** `useProbe` for a call with a written record: the record names the path and parses the answer. */
function useRecordProbe<R extends AppProcedure>(
  enabled: boolean,
  name: string,
  record: R,
  input: ProcedureInput<R>,
): Resource<ProcedureOutput<R>> {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      enabled && userId ? api.call(record, input, { signal }) : Promise.resolve(authoredRefusal('aborted', { key: 'beforeDispatch' })),
    `started-${name}:${userId}:${enabled}`,
  ).resource;
}

/** "Has a line of these kinds ever been posted": a one-line, kind-filtered read of the history, following the cursor. */
function useEver(enabled: boolean, name: string, filter: { kind: readonly ActivityKind[] }): Resource<{ found: boolean }> {
  const { api, userId } = useSession();
  return useResource(async (signal): Promise<ApiResult<{ found: boolean }>> => {
    if (!enabled || !userId) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    let cursor: string | undefined;
    for (let page = 0; page < EVER_PAGES; page++) {
      const result = await api.call(
        BANK_ACTIVITY_LIST,
        { ...filter, kind: [...filter.kind], limit: 1, ...(cursor ? { cursor } : {}) },
        {
          signal,
        },
      );
      if (!result.ok) return result;
      if (result.data.items.length > 0) return { ok: true, data: { found: true } };
      if (!result.data.nextCursor) return { ok: true, data: { found: false } };
      cursor = result.data.nextCursor;
    }
    return authoredRefusal('error', { key: 'loadFailed' });
  }, `started-${name}:${userId}:${enabled}`).resource;
}

/**
 * The venue's balances for each trading account the person has: the venue account every wallet they connected owns
 * (row d115). The wallets are svc-protocol's record of the person (`venueWallet.status`), so the answer is the same on
 * any device and after the browser is cleared; a blocked wallet is not read. Each account is then read from the venue
 * through svc-trade's user-venue door, the read Home's total and Assets make. An account the venue gives no answer for
 * is null, never an empty one. INTAFACED's ledger is not read here: a deposit into it is no deposit at the venue.
 */
function useVenueAccounts(enabled: boolean): VenueAccounts {
  const { api, userId } = useSession();
  const { resource } = useResource(async (signal): Promise<ApiResult<VenueAccounts>> => {
    if (!enabled || !userId) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    const wallets = await api.call(PROTOCOL_VENUE_WALLET_STATUS, undefined, { signal });
    if (!wallets.ok) return wallets;
    const owners = new Set(
      wallets.data.connections
        .filter((connection) => connection.status !== 'blocked')
        .map((connection) => connection.address.toLowerCase()),
    );
    const venue = venueApi(api);
    const accounts = await Promise.all(
      [...owners].map(async (owner) => {
        const read = await venue.balances(owner, signal);
        return read.ok ? { balances: read.data.value } : null;
      }),
    );
    return { ok: true, data: { state: 'read', accounts } };
  }, `started-venue:${userId}:${enabled}`);
  return useMemo(
    () => (resource.status === 'loading' ? { state: 'loading' } : resource.status === 'failed' ? { state: 'unread' } : resource.data),
    [resource],
  );
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
 * The six Get started steps, each from a real record: the session (register), verification, passkeys, the venue's
 * balances for the person's trading account (add money), the money history (first trade) and price alerts. Nothing is
 * stored on this device, so clearing the browser changes no step. A read that fails is `unknown`, never `done`.
 */
export function useGetStarted(enabled: boolean): Step[] {
  const kyc = useRecordProbe(enabled, 'kyc', IDENTITY_KYC_STATUS, { limit: 10 });
  const passkeys = useProbe(enabled, 'passkeys', 'identity', 'webauthn.list', { limit: 10 }, startedPasskeysSchema);
  const alerts = useRecordProbe(enabled, 'alerts', NOTIFY_ALERTS, { limit: 100 });
  const venueAccounts = useVenueAccounts(enabled);
  // A conversion is a first trade too; Activity only names it apart (svc-bank `convert`).
  const trades = useEver(enabled, 'trade', { kind: ['trade', 'convert'] });

  return useMemo(() => {
    const verify = fromProbe(kyc, verificationStatus);
    return buildSteps({
      // Home is only drawn for a signed-in person: the account exists.
      register: 'done',
      verify,
      secure: fromProbe(passkeys, (data) => securityStatus(data.length)),
      deposit: depositStatus(venueAccounts),
      trade: tradeStatus(ever(trades, verify)),
      alert: fromProbe(alerts, (data) => alertStatus(data.items)),
    });
  }, [kyc, passkeys, alerts, venueAccounts, trades]);
}

/**
 * The Get started tile on either Home: shown to a signed-in person until every step is done or they hide it (hiding is
 * remembered per person on this device; it is a view choice, not a step). Its reads run unless the person hid it: with
 * no stored tick, only they can tell that every step is still done.
 */
export function useStartedTile(
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
  const steps = useGetStarted(on);
  const { complete, settled } = progress(steps);
  const lastOpen = useMemo(() => readLastOpen(userId), [userId]);
  useEffect(() => {
    if (on && settled) writeLastOpen(userId, !complete);
  }, [on, settled, complete, userId]);
  // until every step is read, draw the list only if it was open last time (readLastOpen)
  return { show: on && !complete && (settled || lastOpen), steps, hide };
}
