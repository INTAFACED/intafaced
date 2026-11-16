/**
 * The person's step-up extras (BK-safe-01, J-bank-18 #4), asked of svc-identity, which owns them.
 *
 * WHAT IT STOPS. A send to another person (`transfers.toUser`) in the allowance's asset and above it waits while any
 * chosen control cannot be checked: it never passes (`bank.extra_controls_pending`). No control has a check yet (a trusted
 * contact, a QR code or a video call needs an outside rail, and the known-location check is not built), so today every
 * send above the allowance is refused, with nothing moved. A send in another asset, to oneself, or at or under the
 * allowance is not touched. Bank keeps no copy of the extras: it asks per send.
 *
 * WHAT IS ASKED. Identity `GET /internal/extra-controls/:userId` (`extraControlsForSchema`), service-authenticated. A
 * transport error, a timeout, a non-2xx, an unreadable body or a body about another user is UNAVAILABLE
 * (`bank.extra_controls_unavailable`): nothing is sent and the person may retry. No IDENTITY_URL is a deployment gap
 * (`bank.extra_controls_unset`).
 */
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { extraControlsForSchema, type ExtraControlsFor } from '@intafaced/contracts/identity-safety';
import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

export interface ExtraControlsPort {
  read(userId: string): Promise<ExtraControlsFor>;
}

const FETCH_MS = 3_000;

/** Refuses a send that the person's own extras hold. Call before anything is posted. */
export async function assertExtrasAllow(
  port: ExtraControlsPort,
  input: { userId: string; toUserId: string; assetId: string; amount: Amount },
): Promise<void> {
  if (input.toUserId.trim().toLowerCase() === input.userId.toLowerCase()) return;
  const extras = await port.read(input.userId);
  const allowance = extras.allowance;
  if (!allowance || extras.controls.length === 0 || allowance.assetId !== input.assetId) return;
  if (compare(input.amount, parseAmount(allowance.amount)) <= 0) return;
  throw new BankError(
    `This send is above your extra-checks allowance of ${allowance.amount} ${allowance.assetId}, and those checks cannot be done yet, so it waits: nothing was sent. Send ${allowance.amount} ${allowance.assetId} or less, or change your extra checks.`,
    'bank.extra_controls_pending',
  );
}

export function unconfiguredExtraControls(): ExtraControlsPort {
  return {
    async read() {
      throw new BankError('IDENTITY_URL is unset, so svc-bank cannot check the extra checks on a send', 'bank.extra_controls_unset');
    },
  };
}

function unavailable(message: string): BankError {
  return new BankError(message, 'bank.extra_controls_unavailable');
}

export function createIdentityExtraControls(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ExtraControlsPort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const log = (detail: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event: 'bank.extra_controls_check_failed', ...detail }));
  return {
    async read(userId) {
      const id = userId.trim();
      const target = `${base}/internal/extra-controls/${encodeURIComponent(id)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        log({ userId: id, reason: `request failed: ${err instanceof Error ? err.name : 'unknown'}` });
        throw unavailable('Your extra checks could not be read right now. Nothing was sent. Try again shortly.');
      }
      if (!response.ok) {
        log({ userId: id, reason: 'non-2xx', httpStatus: response.status });
        throw unavailable('Your extra checks could not be read right now. Nothing was sent. Try again shortly.');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        log({ userId: id, reason: 'body was not JSON' });
        throw unavailable('Your extra checks could not be read right now. Nothing was sent. Try again shortly.');
      }
      const parsed = extraControlsForSchema.safeParse(body);
      if (!parsed.success || parsed.data.userId.toLowerCase() !== id.toLowerCase()) {
        log({ userId: id, reason: parsed.success ? 'answered about a different user' : 'body failed its schema' });
        throw unavailable('Your extra checks could not be read right now. Nothing was sent. Try again shortly.');
      }
      return parsed.data;
    },
  };
}

/** In-memory extras for tests. `failWith` makes every read throw (identity down). */
export function memoryExtraControls(table: Record<string, Omit<ExtraControlsFor, 'userId'>> = {}) {
  let failure: BankError | null = null;
  return {
    failWith(error: BankError | null) {
      failure = error;
    },
    async read(userId: string): Promise<ExtraControlsFor> {
      if (failure) throw failure;
      return { userId, ...(table[userId] ?? { controls: [], allowance: null }) };
    },
  } satisfies ExtraControlsPort & { failWith(error: BankError | null): void };
}
