/**
 * The customer security lock (W-withdraw-09, wallet-withdraw-015), asked of svc-identity, which owns it.
 *
 * WHAT IT STOPS HERE. While the lock holds, svc-bank refuses adding or removing a withdrawal address and sending to
 * one: `bank.security_locked`. The owner's self-freeze (I-account-lifecycle-08) stops the same things, first:
 * `bank.account_frozen_self`. Identity refuses the password change itself. Bank keeps no copy of the lock (it would be a
 * second copy that could disagree), so it asks per request, the way it asks identity whether a recipient may receive.
 *
 * WHAT IS ASKED. Identity `GET /internal/security-lock/:userId` (`securityLockSchema`) and
 * `GET /internal/self-freeze/:userId` (`selfFreezeStateSchema`), both service-authenticated, together on every ask.
 * `locked` or `frozen` true refuses. Either read failing fails the ask. A 404, a transport error, a timeout, a non-2xx, an unreadable body or a body about another user is
 * UNAVAILABLE (`bank.security_lock_unavailable`): nothing changes and the customer may retry. A bank that cannot tell
 * whether the lock holds does not let an address or a withdrawal through. No IDENTITY_URL is a deployment gap
 * (`bank.security_lock_unset`), not an outage.
 */

import {
  securityLockSchema,
  selfFreezeStateSchema,
  serviceCallSigner,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { BankError } from './errors.js';

export interface SecurityLockState {
  locked: boolean;
  /** When the lock ends, fixed by identity when the owner asked to unlock; null while no unlock is asked for. */
  unlocksAt: string | null;
  /** The owner froze the account themselves (I-account-lifecycle-08). Absent reads as not frozen (test ports only). */
  selfFrozen?: boolean;
}

export interface SecurityLockPort {
  /** The lock as identity holds it now, or throws `bank.security_lock_unavailable` / `bank.security_lock_unset`. */
  read(userId: string): Promise<SecurityLockState>;
}

/** Refuses `bank.security_locked` while the owner's lock holds. Call it before anything is written. */
export async function assertSecurityLockOpen(port: SecurityLockPort, userId: string, action: string): Promise<SecurityLockState> {
  const lock = await port.read(userId);
  if (lock.selfFrozen) {
    throw new BankError(`The owner froze this account, so ${action} is refused until the freeze is lifted`, 'bank.account_frozen_self');
  }
  if (lock.locked) {
    throw new BankError(
      `The account's security lock is on, so ${action} is refused until it ends${lock.unlocksAt ? ` (${lock.unlocksAt})` : ''}`,
      'bank.security_locked',
    );
  }
  return lock;
}

/** The port a deployment has when nothing was configured: every ask refuses. Never "no lock". */
export function unconfiguredSecurityLock(why = 'IDENTITY_URL is unset, so svc-bank cannot check the security lock'): SecurityLockPort {
  return {
    async read() {
      throw new BankError(why, 'bank.security_lock_unset');
    },
  };
}

const FETCH_MS = 3_000;

export type SecurityLockFailureLog = (detail: { userId: string; reason: string; httpStatus?: number }) => void;

/** SERVER LOG ONLY: the one place an operator learns why the lock could not be read. */
export const logSecurityLockFailure: SecurityLockFailureLog = (detail) => {
  console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event: 'bank.security_lock_check_failed', ...detail }));
};

function unavailable(message: string): BankError {
  return new BankError(message, 'bank.security_lock_unavailable');
}

export function createIdentitySecurityLock(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  log: SecurityLockFailureLog = logSecurityLockFailure,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): SecurityLockPort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  async function ask<T extends { userId: string }>(
    id: string,
    path: 'security-lock' | 'self-freeze',
    schema: { safeParse(body: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T> {
    let response: Response;
    try {
      const target = `${base}/internal/${path}/${encodeURIComponent(id)}`;
      response = await fetchFn(target, {
        method: 'GET',
        headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
        signal: AbortSignal.timeout(FETCH_MS),
      });
    } catch (err) {
      log({ userId: id, reason: `identity ${path} request failed: ${err instanceof Error ? err.name : 'unknown'}` });
      throw unavailable('identity did not answer the security lock check');
    }
    if (!response.ok) {
      log({ userId: id, reason: `identity ${path} answered non-2xx`, httpStatus: response.status });
      throw unavailable(`identity refused the security lock check (${response.status})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      log({ userId: id, reason: `identity ${path} body was not JSON`, httpStatus: response.status });
      throw unavailable('identity returned an unreadable security lock');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data.userId.toLowerCase() !== id.toLowerCase()) {
      log({
        userId: id,
        reason: parsed.success ? `identity ${path} answered about a different user` : `identity ${path} body failed its schema`,
        httpStatus: response.status,
      });
      throw unavailable('identity returned an unreadable security lock');
    }
    return parsed.data;
  }
  return {
    async read(userId) {
      const id = userId.trim();
      if (!id) throw unavailable('a security lock check needs a user');
      const [lock, freeze] = await Promise.all([
        ask(id, 'security-lock', securityLockSchema),
        ask(id, 'self-freeze', selfFreezeStateSchema),
      ]);
      return { locked: lock.locked, unlocksAt: lock.unlocksAt, selfFrozen: freeze.frozen };
    },
  };
}

/** An in-memory lock for tests: anyone not listed is unlocked. `failWith` makes every ask throw (identity down). */
export function memorySecurityLock(locked: Readonly<Record<string, SecurityLockState>> = {}): SecurityLockPort & {
  set(userId: string, state: SecurityLockState): void;
  failWith(error: BankError | null): void;
  readonly asked: string[];
} {
  const table = new Map<string, SecurityLockState>(Object.entries(locked));
  let failure: BankError | null = null;
  const asked: string[] = [];
  return {
    asked,
    set: (userId, state) => void table.set(userId, state),
    failWith: (error) => {
      failure = error;
    },
    async read(userId) {
      asked.push(userId);
      if (failure) throw failure;
      return table.get(userId) ?? { locked: false, unlocksAt: null };
    },
  };
}
