/**
 * Drop `/private/stream` when the last enrolled passkey is unenrolled.
 * Reuses assertSessionPasskey. No invented session. No invented challenge.
 */
import { assertSessionPasskey } from './session-passkey.js';

export function lastPasskeyUnenrollDropsStream(body: unknown): void {
  assertSessionPasskey(body);
}
