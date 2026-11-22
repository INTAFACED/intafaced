import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { KitWalletProvider, useWallet } from '../protocol';
import { venueCopy, type VenueMode } from '../trade';

/**
 * The venue parts /fees and /fees/my-tier draw, from the kit: the same words, test ids and wallet as the trade desk's own
 * (`features/trade/venue/VenueKit.tsx`), which keeps its look for the desk.
 */

/** The TEST label every venue figure carries while the venue is a TEST one. */
export function FeesTestMark({ test }: { test: boolean }) {
  const { t } = venueCopy.useCopy();
  if (!test) return null;
  return (
    <span className="lt-test" data-testid="venue-test" title={t('Venue TEST note')}>
      {t('TEST')}
    </span>
  );
}

/** The venue's own wallet connection, on the network its signatures name, as the desk's frame keeps it. */
export function FeesVenueFrame({ mode, children }: { mode: Extract<VenueMode, { mode: 'on' }>; children: ReactNode }) {
  const status = mode.status;
  const chainId = status.available && status.chainId ? status.chainId : undefined;
  return (
    <KitWalletProvider chainId={chainId} scope="venue-desk">
      {children}
    </KitWalletProvider>
  );
}

/** Connect, the connected address and network, and the switch when the wallet is on another network. */
export function FeesWalletBar() {
  const { t } = venueCopy.useCopy();
  const wallet = useWallet();
  return (
    <section className="lt-stack" aria-label={t('Your wallet')} data-testid="venue-wallet">
      <h2>{t('Your wallet')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl className="lt-kv">
            <div>
              <dt>{t('Connected address')}</dt>
              <dd className="lt-mono lt-wrap" data-testid="venue-wallet-address">
                {wallet.address.toLowerCase()}
              </dd>
            </div>
            <div>
              <dt>{t('Network')}</dt>
              <dd className="lt-mono">{wallet.chainId ?? ''}</dd>
            </div>
          </dl>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {t('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <Button onClick={() => void wallet.switchNetwork()}>{t('Switch network')}</Button>
            </p>
          ) : null}
          <div className="lt-actions">
            <Button onClick={wallet.disconnect}>{t('Disconnect')}</Button>
          </div>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p className="lt-hint">{t('No wallet')}</p>
      ) : (
        <div className="lt-actions">
          {wallet.wallets.map((entry) => (
            <Button
              key={entry.info.uuid}
              tone="primary"
              disabled={wallet.status === 'connecting'}
              onClick={() => void wallet.connect(entry)}
            >
              {t('Connect wallet', { name: entry.info.name })}
            </Button>
          ))}
        </div>
      )}
      {wallet.problem ? <p role="alert">{wallet.problem}</p> : null}
    </section>
  );
}
