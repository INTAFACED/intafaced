/**
 * Enroll a passkey after the last one was unenrolled.
 * Reuses beginEnrollPasskey / enrollPasskey. Mint, rotate, and session can verify again.
 * No invented challenge.
 */
import { beginEnrollPasskey, enrollPasskey } from './enroll-passkey.js';

export async function beginEnrollAfterLastUnenroll(...args: Parameters<typeof beginEnrollPasskey>): ReturnType<typeof beginEnrollPasskey> {
  return beginEnrollPasskey(...args);
}

export async function enrollAfterLastUnenroll(...args: Parameters<typeof enrollPasskey>): ReturnType<typeof enrollPasskey> {
  return enrollPasskey(...args);
}
