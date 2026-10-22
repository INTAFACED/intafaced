/**
 * Keep `/private/stream` when a remaining enrolled passkey verifies after
 * the first of two was unenrolled. Drop only if no remaining passkey verifies.
 * Reuses assertSessionPasskey. No invented session. No invented challenge.
 */
import { assertSessionPasskey } from './session-passkey.js';

export function remainingPasskeyKeepsStream(body: unknown): void {
  assertSessionPasskey(body);
}
