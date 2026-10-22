/**
 * Open a private session only when at least one enrolled passkey still verifies
 * after the first of two was unenrolled. Refuse if none remain.
 * Reuses assertSessionPasskey. No invented session. No invented challenge.
 */
import { assertSessionPasskey } from './session-passkey.js';

export function remainingPasskeyOpensSession(body: unknown): void {
  assertSessionPasskey(body);
}
