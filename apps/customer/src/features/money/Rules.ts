import type { CategoryPrefRow } from '../../screens/notifications/notify-api';
import type { rulesCopy } from './rules-copy';
import { withCode } from '../../shared/reference';

type Copy = ReturnType<typeof rulesCopy.useCopy>['t'];

/** What one notification channel's choice says on the rules page: unknown, not connected, off for the platform, locked, on or off. */
export function choiceWords(t: Copy, row: CategoryPrefRow | undefined) {
  if (!row) return t('choiceUnknown');
  if (row.notConnected) return withCode(t('choiceNotConnected'), row.notConnected, (code) => t('reference', { code }));
  if (!row.configured) return t('choicePlatformOff');
  if (row.locked) return t('choiceLocked');
  return row.enabled ? t('choiceOn') : t('choiceOff');
}
