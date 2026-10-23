import { protocolCopy } from './copy';
import { lastShellRoute, type ShellName } from './shell-state';
import { usePreferences } from '../../shared/preferences';
import './shell-switch.css';

/**
 * The Exchange | Web3 switch (HM-shell-01), the same control in both shells' top bars. Each side opens the last route of
 * its shell on this device, or the shell's default when there is none.
 */
export function ShellSwitch({ current, className }: { current: ShellName; className?: string }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  return (
    <nav className={className ? `web3-switch ${className}` : 'web3-switch'} aria-label={t('shellSwitch')}>
      <a href={lastShellRoute('exchange')} aria-current={current === 'exchange' ? 'page' : undefined}>
        {t('shellExchange')}
      </a>
      <a href={lastShellRoute('web3')} aria-current={current === 'web3' ? 'page' : undefined}>
        {t('shellWeb3')}
      </a>
    </nav>
  );
}
