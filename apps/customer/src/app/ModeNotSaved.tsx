import { useAccountViewStatus } from '../features/account/ViewSync';
import { shellCopy } from './shell-copy';

/**
 * Said beside the Simple or Pro switch (the top bar's, and the account menu's below 1000 px) when the account refused or
 * never got the last view write: the choice stays on this device, as the account's View page says too (J-home-ia-03 #2).
 */
export function ModeNotSaved() {
  const { t } = shellCopy.useCopy();
  if (useAccountViewStatus() !== 'not-saved') return null;
  return (
    <span role="status" data-view-sync="not-saved" className="tb-mode-note">
      {t('Mode not saved')}
    </span>
  );
}
