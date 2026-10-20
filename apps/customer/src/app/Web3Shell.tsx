import { useMemo, type ReactNode } from 'react';
import { HideBalancesProvider, ToastProvider, TooltipProvider, Wordmark } from '@intafaced/ui';
import { isServiceNotConnected, networkLabel } from '../features/protocol/blockers';
import { createProtocolApi } from '../features/protocol/api';
import { protocolCopy } from '../features/protocol/copy';
import { lastShellRoute } from '../features/protocol/shell-state';
import { useApi } from '../features/session/session';
import { usePreferences } from '../shared/preferences';
import { useResource } from '../shared/resource';
import { SessionNotice } from './SessionNotice';
import '../features/protocol/web3-shell.css';

/** Web3 nav (IA-SPEC 2.8): label key, route, and the path prefixes that mark it current. */
const NAV = [
  { key: 'nav_swap', href: '/dex', match: (p: string) => p === '/dex' || p.startsWith('/dex/tokens') },
  { key: 'nav_pools', href: '/dex/pools', match: (p: string) => p.startsWith('/dex/pools') },
  { key: 'nav_positions', href: '/dex/positions', match: (p: string) => p.startsWith('/dex/positions') },
  { key: 'nav_wallet', href: '/wallet', match: (p: string) => p.startsWith('/wallet') },
  { key: 'nav_explorer', href: '/chain', match: (p: string) => p.startsWith('/chain') },
  { key: 'nav_protocol', href: '/protocol', match: (p: string) => p.startsWith('/protocol') },
] as const;
/** The phone bar drops Positions and Protocol for an All entry that opens the full service index. */
const PHONE = ['nav_swap', 'nav_pools', 'nav_wallet', 'nav_explorer'] as const;

/**
 * The Web3 frame: its own top bar with the Exchange | Web3 switch, the network chip, the "Not INTACHAIN" pill and the wallet
 * chip, then the Web3 nav, and a phone bottom bar. The chip reads the network the Protocol service reports and labels it
 * through `networkLabel`; nothing here ever says INTACHAIN mainnet.
 */
export function Web3Shell({ path, children }: { path: string; children: ReactNode }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const chain = useResource((signal) => api.chainStatus(signal), 'web3-shell:chain').resource;
  const chip =
    chain.status === 'loading'
      ? t('networkChecking')
      : chain.status === 'failed'
        ? t('chipUnreachable', { reason: isServiceNotConnected(chain.failure.code) ? t('chipNotConnected') : t('chipNoAnswer') })
        : (() => {
            const label = networkLabel(chain.data.configuredChainId);
            return label.known ? `${label.name} · ${label.note.replace(/\.$/, '')}` : t('chipUnrecognised');
          })();
  const exchangeHref = lastShellRoute('exchange');
  return (
    <HideBalancesProvider hidden={false}>
      <TooltipProvider>
        <ToastProvider>
          <div className="if-app web3-app" data-shell="web3">
            <a href="#main" className="skip-link">
              {t('skip')}
            </a>
            <header className="tb web3-bar">
              <a className="tb-brand" href="/home" aria-label={t('shellHome')}>
                <Wordmark />
              </a>
              <nav className="web3-switch" aria-label={t('shellSwitch')}>
                <a href={exchangeHref}>{t('shellExchange')}</a>
                <a href={lastShellRoute('web3')} aria-current="page">
                  {t('shellWeb3')}
                </a>
              </nav>
              <nav className="tb-nav" aria-label={t('shellNav')}>
                <ul>
                  {NAV.map((item) => (
                    <li key={item.key} className="tb-item">
                      <a className="tb-tab" href={item.href} aria-current={item.match(path) ? 'page' : undefined}>
                        {t(item.key)}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="tb-right web3-chips">
                <span className="web3-chip" data-chip="network" role="status">
                  {chip}
                </span>
                <span className="web3-chip web3-chip--pill" data-chip="label">
                  {t('bannerPill')}
                </span>
                <span className="web3-chip" data-chip="wallet">
                  {t('walletNone')}
                </span>
              </div>
            </header>
            <main id="main" tabIndex={-1}>
              <SessionNotice />
              {children}
            </main>
            <nav className="mobile-doors web3-doors" aria-label={t('shellNavPhone')}>
              {PHONE.map((key) => {
                const item = NAV.find((entry) => entry.key === key)!;
                return (
                  <a key={key} href={item.href} aria-current={item.match(path) ? 'page' : undefined}>
                    {t(key)}
                  </a>
                );
              })}
              <a href="/more">{t('nav_all')}</a>
            </nav>
          </div>
        </ToastProvider>
      </TooltipProvider>
    </HideBalancesProvider>
  );
}
