import { useMemo, type ReactNode } from 'react';
import { HideBalancesProvider, ToastProvider, TooltipProvider, BrandBar } from '@intafaced/ui';
import { isServiceNotConnected, networkLabel } from '../features/protocol/blockers';
import { createProtocolApi } from '../features/protocol/api';
import { protocolCopy } from '../features/protocol/copy';
import { ShellSwitch } from '../features/protocol/ShellSwitch';
import { shortAddress } from '../features/protocol/wallet/eip1193';
import { WalletProvider, useWallet } from '../features/protocol/wallet/WalletProvider';
import { RegionContext, REGION_BLOCKED_CODE } from '../features/protocol/region';
import { useApi, useSession } from '../features/session/session';
import { usePreferences } from '../shared/preferences';
import { useResource } from '../shared/resource';
import { SessionNotice } from './SessionNotice';
import { shellCopy } from './shell-copy';
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
  return (
    <WalletProvider>
      <Web3Frame path={path}>{children}</Web3Frame>
    </WalletProvider>
  );
}

function Web3Frame({ path, children }: { path: string; children: ReactNode }) {
  const wallet = useWallet();
  const { session, restoring } = useSession();
  const { t: shell } = shellCopy.useCopy();
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const chain = useResource((signal) => api.chainStatus(signal), 'web3-shell:chain').resource;
  // The edge refuses every Protocol read from a blocked region. The shell says so once, in words, and the rooms offer no
  // signing action while it holds.
  const regionBlocked = chain.status === 'failed' && chain.failure.code === REGION_BLOCKED_CODE;
  const chip =
    chain.status === 'loading'
      ? t('networkChecking')
      : chain.status === 'failed'
        ? t('chipUnreachable', { reason: isServiceNotConnected(chain.failure.code) ? t('chipNotConnected') : t('chipNoAnswer') })
        : (() => {
            const label = networkLabel(chain.data.configuredChainId);
            return label.known ? `${label.name} · ${label.note.replace(/\.$/, '')}` : t('chipUnrecognised');
          })();
  return (
    <HideBalancesProvider hidden={false}>
      <TooltipProvider>
        <ToastProvider>
          <div className="if-app web3-app" data-shell="web3">
            <a href="#main" className="skip-link">
              {t('skip')}
            </a>
            <header data-testid="tb" className="tb web3-bar">
              <a className="tb-brand" href="/home" aria-label={t('shellHome')}>
                <BrandBar />
              </a>
              <ShellSwitch current="web3" here={path} />
              <nav data-testid="tb-nav" className="tb-nav" aria-label={t('shellNav')}>
                <ul>
                  {NAV.map((item) => (
                    <li key={item.key} data-testid="tb-item" className="tb-item">
                      <a data-testid="tb-tab" className="tb-tab" href={item.href} aria-current={item.match(path) ? 'page' : undefined}>
                        {t(item.key)}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div data-testid="tb-right" className="tb-right web3-chips">
                <span className="web3-chip" data-chip="network" role="status" title={chip}>
                  {chip}
                </span>
                <span className="web3-chip web3-chip--pill" data-chip="label">
                  {t('bannerPill')}
                </span>
                <span className="web3-chip" data-chip="wallet">
                  {wallet.status === 'connecting'
                    ? t('walletConnecting')
                    : wallet.status === 'connected' && wallet.address && wallet.connected
                      ? wallet.guard?.ok
                        ? `${wallet.connected.info.name} · ${shortAddress(wallet.address)}`
                        : `${t('walletWrongNetwork')} · ${shortAddress(wallet.address)}`
                      : t('walletNone')}
                </span>
                {session || restoring ? null : (
                  <>
                    {/* Signed out, every Web3 room is the public read-only view; signing in returns through Home. */}
                    <a className="tb-login" href="/login">
                      {shell('Log in')}
                    </a>
                    <a className="tb-signup" href="/register">
                      {shell('Sign up')}
                    </a>
                  </>
                )}
              </div>
            </header>
            <main id="main" tabIndex={-1}>
              <SessionNotice />
              {regionBlocked && (
                <p className="web3-region-notice" role="alert" data-notice="region" data-code={REGION_BLOCKED_CODE}>
                  {t('regionBlocked')}
                </p>
              )}
              <RegionContext.Provider value={regionBlocked}>{children}</RegionContext.Provider>
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
