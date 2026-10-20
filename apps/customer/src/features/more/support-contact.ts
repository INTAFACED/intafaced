import { supportEmail } from './support-desk';

/**
 * The one place the support address is read, or `null` while none is published. Set `VITE_SUPPORT_EMAIL` at build time.
 * Read at call time so a screen never holds a stale answer. There is no fallback address: every reader says "not set".
 */
export function supportContactEmail(): string | null {
  return supportEmail(import.meta.env.VITE_SUPPORT_EMAIL as string | undefined);
}
