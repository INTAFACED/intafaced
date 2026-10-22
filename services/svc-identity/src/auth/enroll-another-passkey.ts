/**
 * Enroll a second passkey without dropping the first.
 * Reuses beginEnrollPasskey / enrollPasskey (same args). The library mints the
 * challenge; persist already appends onto existing creds. Later mint, rotate,
 * and session verify can use either stored cred.
 */
import { beginEnrollPasskey, enrollPasskey } from './enroll-passkey.js';

export async function beginEnrollAnotherPasskey(...args: Parameters<typeof beginEnrollPasskey>): ReturnType<typeof beginEnrollPasskey> {
  return beginEnrollPasskey(...args);
}

export async function enrollAnotherPasskey(...args: Parameters<typeof enrollPasskey>): ReturnType<typeof enrollPasskey> {
  return enrollPasskey(...args);
}
