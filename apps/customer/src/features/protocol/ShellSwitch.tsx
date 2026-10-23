import { protocolCopy } from './copy';
import { lastShellRoute, type ShellName } from './shell-state';
import { usePreferences } from '../../shared/preferences';
import './shell-switch.css';

/**
 * The Exchange | Web3 switch (HM-shell-01), the same control in both shells' top bars. The other side opens the last route
 * of its shell on this device, or the shell's default when there is none; the current side is `here`, the route on screen
 * (the stored route is written after the render that shows a new route, so it would be one step behind).
 */
export function ShellSwitch({ current, here, className }: { current: ShellName; here: string; className?: string }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  const href = (shell: ShellName) => (shell === current ? here : lastShellRoute(shell));
  return (
    <nav className={className ? `web3-switch ${className}` : 'web3-switch'} aria-label={t('shellSwitch')}>
      <a href={href('exchange')} aria-current={current === 'exchange' ? 'page' : undefined}>
        {t('shellExchange')}
      </a>
      <a href={href('web3')} aria-current={current === 'web3' ? 'page' : undefined}>
        {t('shellWeb3')}
      </a>
    </nav>
  );
}
