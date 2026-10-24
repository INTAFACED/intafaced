/**
 * Identity's trusted devices, as svc-bank asks about them (W-withdraw-09, J-wallet-04 #5). An access token's `dev` claim
 * names the device it was minted on; it does not say the device is still trusted, or how it came to be. Before one
 * device approves a new withdrawal address saved on another, the bank asks identity
 * (`GET /internal/trusted-devices/:userId/:deviceId`, `trustedDeviceStateSchema`, service-authenticated) at that moment.
 *
 * A transport error, a timeout, a non-2xx or an unreadable body is UNAVAILABLE (`bank.address_approval_device_unavailable`):
 * nothing is approved and the customer may retry or use the emailed link. No IDENTITY_URL is the same refusal, never
 * "trusted".
 */

import {
  serviceCallSigner,
  trustedDeviceReadPath,
  trustedDeviceStateSchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type TrustedDeviceState,
} from '@intafaced/contracts';
import { BankError } from '../errors.js';

export interface TrustedDevicePort {
  /** The device as identity holds it now, or throws `bank.address_approval_device_unavailable`. */
  read(userId: string, deviceId: string): Promise<TrustedDeviceState>;
}

const unavailable = (why: string) =>
  new BankError(`Whether this device can approve could not be checked: ${why}`, 'bank.address_approval_device_unavailable');

/** No IDENTITY_URL: every ask refuses, so no device is ever taken as trusted. */
export function unconfiguredTrustedDevices(): TrustedDevicePort {
  return {
    async read() {
      throw unavailable('IDENTITY_URL is unset');
    },
  };
}

const FETCH_MS = 3_000;

export function createIdentityTrustedDevices(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): TrustedDevicePort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId, deviceId) {
      const target = `${base}${trustedDeviceReadPath(userId, deviceId)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        throw unavailable(`identity did not answer (${err instanceof Error ? err.name : 'unknown'})`);
      }
      if (!response.ok) throw unavailable(`identity answered ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unavailable('identity answered with no readable body');
      }
      const parsed = trustedDeviceStateSchema.safeParse(body);
      if (!parsed.success) throw unavailable('identity answered outside the trusted-device schema');
      return parsed.data;
    },
  };
}

/** In-memory devices for tests: a device not listed reads as identity answers an unknown one. */
export function memoryTrustedDevices(
  devices: Readonly<Record<string, TrustedDeviceState>> = {},
  newDeviceCheck: 'on' | 'off' = 'on',
): TrustedDevicePort & { set(deviceId: string, state: TrustedDeviceState): void; failWith(error: BankError | null): void } {
  const table = new Map<string, TrustedDeviceState>(Object.entries(devices));
  let failure: BankError | null = null;
  return {
    set: (deviceId, state) => void table.set(deviceId.toLowerCase(), state),
    failWith: (error) => {
      failure = error;
    },
    async read(_userId, deviceId) {
      if (failure) throw failure;
      return table.get(deviceId.toLowerCase()) ?? { live: false, trustedBy: null, newDeviceCheck };
    },
  };
}

/**
 * Whether identity's answer lets this device approve: live, proved (made on sign-up, or approved by a mailed code or a
 * proved device; a device trusted as it signed in while the check was off is not), and the owner's new-device check on
 * now, so a new browser cannot make itself trusted by signing in.
 */
export function deviceMayApprove(state: TrustedDeviceState): boolean {
  return state.live && state.newDeviceCheck === 'on' && (state.trustedBy === 'sign-up' || state.trustedBy === 'approval');
}
