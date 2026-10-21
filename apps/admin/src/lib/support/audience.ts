import type { SupportKbAudience } from '@intafaced/contracts';

/**
 * The help article audiences, in the order the selector shows them. The contracts package is imported for its type
 * only: a client component may not pull its runtime into the browser bundle. `audience.test.ts` pins this list to
 * the contract's own.
 */
export const KB_AUDIENCES: readonly SupportKbAudience[] = ['public', 'signed_in', 'staff'];
