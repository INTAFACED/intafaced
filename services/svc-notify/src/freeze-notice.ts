import { isMessageKey } from '@intafaced/i18n';
import type { NotifyService } from './notify-service.js';

/**
 * One audience-all inbox notice when the platform-wide posting freeze (svc-ledger)
 * is set or cleared.
 *
 * Reports the svc-ledger posting freeze only. It neither sets nor clears a freeze
 * and is not about the single-account freeze that belongs to svc-identity.
 *
 * The event carries an internal reason and an actor. Neither is read here: they
 * are not params, not copy, and not in any response. A customer learns that
 * postings are paused or resumed, nothing about why or who.
 */

export const FREEZE_NOTICE_SUBJECT = 'intafaced.notify.ledger.freeze.updated';
export const FREEZE_COPY_UNSET = 'notify.freeze_copy_unset' as const;

export const FREEZE_SET_KIND = 'ledger.freeze.set';
export const FREEZE_CLEARED_KIND = 'ledger.freeze.cleared';
export const FREEZE_SET_KEYS = { title: 'notify.ledger.freeze.set.title', body: 'notify.ledger.freeze.set.body' } as const;
export const FREEZE_CLEARED_KEYS = { title: 'notify.ledger.freeze.cleared.title', body: 'notify.ledger.freeze.cleared.body' } as const;

/** The copy keys are not in the catalog: nothing is written, and the event is redelivered. */
export class FreezeCopyUnsetError extends Error {
  readonly code = FREEZE_COPY_UNSET;
  constructor(readonly keys: readonly string[]) {
    super(`${FREEZE_COPY_UNSET}: ${keys.join(', ')}`);
    this.name = 'FreezeCopyUnsetError';
  }
}

export interface FreezeUpdate {
  readonly frozen: boolean;
  readonly changedAt: string;
}

/** Business key `freeze:{changedAt}:{frozen}`; a redelivery writes no second row. */
export async function noticeFreezeChange(
  notify: NotifyService,
  update: FreezeUpdate,
  hasCopy: (key: string) => boolean = isMessageKey,
): Promise<{ inserted: boolean }> {
  const keys = update.frozen ? FREEZE_SET_KEYS : FREEZE_CLEARED_KEYS;
  const missing = [keys.title, keys.body].filter((k) => !hasCopy(k));
  if (missing.length > 0) throw new FreezeCopyUnsetError(missing);
  return notify.createSystemNotice({
    kind: update.frozen ? FREEZE_SET_KIND : FREEZE_CLEARED_KIND,
    titleKey: keys.title,
    bodyKey: keys.body,
    params: { frozen: update.frozen, changedAt: update.changedAt },
    href: null,
    severity: update.frozen ? 'action' : 'info',
    sourceSubject: FREEZE_NOTICE_SUBJECT,
    sourceIdempotencyKey: `freeze:${update.changedAt}:${update.frozen}`,
  });
}
