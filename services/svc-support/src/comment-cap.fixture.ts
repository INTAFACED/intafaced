import type { AccountStateSource } from './account-state.js';
import type { SupportStore } from './store.js';
import { SupportService } from './support-service.js';

/**
 * Test-only: a labelled TEST comment cap (SP-api-01), for tests about something else that have a requester comment.
 * Not an owner value. A blank cap refuses every requester comment, which `comment-key.test.ts` proves on its own.
 */
export const TEST_COMMENT_CAP = 50;

/** A service with only a store, an account reader and the TEST comment cap set. */
export function withTestCommentCap(store?: SupportStore, accounts?: AccountStateSource): SupportService {
  return new SupportService(
    store,
    accounts,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    TEST_COMMENT_CAP,
  );
}
