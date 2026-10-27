/**
 * Identity's recovery claim doors, as svc-bank asks them (RC-identity-08, J-identity-05 #7). Identity holds the owner's
 * recovery keys, the heir they named and the death notice two staff confirmed; svc-bank holds none of it and asks at
 * the moment it needs an answer:
 *
 *   - `GET /internal/recovery-claims/estates/:heirUserId` (`recoveryEstatesSchema`): the accounts this person may claim.
 *   - `POST /internal/recovery-claims/verify` (`recoveryClaimVerdictSchema`): whether these signatures claim this account
 *     for this heir now. A refusal is an answer, not a failure.
 *
 * A transport error, a timeout, a non-2xx or an unreadable body is `bank.recovery_unavailable`: nothing is opened or
 * swept, and the heir may retry. No IDENTITY_URL is the same refusal, never "claimable".
 */

import {
  RECOVERY_CLAIM_VERIFY_PATH,
  recoveryClaimVerdictSchema,
  recoveryEstatesPath,
  recoveryEstatesSchema,
  serviceCallSigner,
  type RecoveryClaimVerdict,
  type RecoveryClaimVerifyRequest,
  type RecoveryEstate,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { BankError } from '../errors.js';

export interface IdentityRecoveryPort {
  /** The accounts `heirUserId` may claim now, or throws `bank.recovery_unavailable`. */
  estates(heirUserId: string): Promise<RecoveryEstate[]>;
  /** Identity's verdict on one claim, or throws `bank.recovery_unavailable`. */
  verify(request: RecoveryClaimVerifyRequest): Promise<RecoveryClaimVerdict>;
}

const unavailable = (why: string) =>
  new BankError(`Recovery claims could not be checked: ${why} [bank.recovery_unavailable]`, 'bank.recovery_unavailable');

/** No IDENTITY_URL: every ask refuses, so no account is ever offered or swept. */
export function unconfiguredIdentityRecovery(): IdentityRecoveryPort {
  return {
    async estates() {
      throw unavailable('IDENTITY_URL is unset');
    },
    async verify() {
      throw unavailable('IDENTITY_URL is unset');
    },
  };
}

const FETCH_MS = 3_000;

export function createIdentityRecovery(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): IdentityRecoveryPort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  async function ask(target: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
    } catch (err) {
      throw unavailable(`identity did not answer (${err instanceof Error ? err.name : 'unknown'})`);
    }
    if (!response.ok) throw unavailable(`identity answered ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw unavailable('identity answered with no readable body');
    }
  }

  return {
    async estates(heirUserId) {
      const target = `${base}${recoveryEstatesPath(heirUserId)}`;
      const body = await ask(target, { method: 'GET', headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }) });
      const parsed = recoveryEstatesSchema.safeParse(body);
      if (!parsed.success) throw unavailable('identity answered outside the estates schema');
      return parsed.data.estates;
    },
    async verify(request) {
      const target = `${base}${RECOVERY_CLAIM_VERIFY_PATH}`;
      const payload = JSON.stringify(request);
      const body = await ask(target, {
        method: 'POST',
        headers: {
          ...sign(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          'content-type': 'application/json',
        },
        body: payload,
      });
      const parsed = recoveryClaimVerdictSchema.safeParse(body);
      if (!parsed.success) throw unavailable('identity answered outside the verdict schema');
      return parsed.data;
    },
  };
}

/** In-memory identity for tests: the estates each heir may claim, and a verdict the test decides per claim. */
export function memoryIdentityRecovery(estates: Readonly<Record<string, RecoveryEstate[]>> = {}): IdentityRecoveryPort & {
  setEstates(heirUserId: string, list: RecoveryEstate[]): void;
  answer(verdict: (request: RecoveryClaimVerifyRequest) => RecoveryClaimVerdict): void;
  failWith(error: BankError | null): void;
  readonly asked: RecoveryClaimVerifyRequest[];
} {
  const table = new Map<string, RecoveryEstate[]>(Object.entries(estates));
  let decide: (request: RecoveryClaimVerifyRequest) => RecoveryClaimVerdict = () => ({
    ok: false,
    code: 'identity.recovery_notice_unconfirmed',
  });
  let failure: BankError | null = null;
  const asked: RecoveryClaimVerifyRequest[] = [];
  return {
    asked,
    setEstates: (heirUserId, list) => void table.set(heirUserId, list),
    answer: (verdict) => {
      decide = verdict;
    },
    failWith: (error) => {
      failure = error;
    },
    async estates(heirUserId) {
      if (failure) throw failure;
      return table.get(heirUserId) ?? [];
    },
    async verify(request) {
      if (failure) throw failure;
      asked.push(request);
      return decide(request);
    },
  };
}
