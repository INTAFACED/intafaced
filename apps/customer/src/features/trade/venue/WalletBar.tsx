import { Button } from '@intafaced/ui/lit';
import { useWallet } from '../../protocol';
import { venueCopy } from './venue-copy';

/**
 * Connect, the connected address and network, and the switch when the wallet is on another network: one panel every
 * venue room and Home's launch total share, drawn from the Volt kit.
 */
export function WalletBar({ compact = false }: { compact?: boolean } = {}) {
  const { t } = venueCopy.useCopy();
  const wallet = useWallet();
  // Compact, once connected: the address and Disconnect on one line, the network named only when it is the wrong one.
  if (compact && wallet.status === 'connected' && wallet.address)
    return (
      <section className="lt-row" aria-label={t('Your wallet')} data-testid="venue-wallet" data-compact="true">
        <span className="lt-mono" data-testid="venue-wallet-address" title={wallet.address.toLowerCase()}>
          {wallet.address.toLowerCase().slice(0, 6)}
          <span data-part="address-middle">{wallet.address.toLowerCase().slice(6, -4)}</span>
          <span data-part="address-end">{wallet.address.toLowerCase().slice(-4)}</span>
        </span>
        {wallet.guard && !wallet.guard.ok ? (
          <span role="alert">
            {t('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
            <Button tone="secondary" size="sm" onClick={() => void wallet.switchNetwork()}>
              {t('Switch network')}
            </Button>
          </span>
        ) : null}
        <Button tone="secondary" size="sm" onClick={wallet.disconnect}>
          {t('Disconnect')}
        </Button>
      </section>
    );
  return (
    <section className="lt-stack" aria-label={t('Your wallet')} data-testid="venue-wallet">
      <h2>{t('Your wallet')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl className="lt-kv">
            <div>
              <dt>{t('Connected address')}</dt>
              <dd className="lt-mono" data-testid="venue-wallet-address" title={wallet.address.toLowerCase()}>
                {/* The whole address stays in the text (copy and checks read it); a desk may show its ends only. */}
                {wallet.address.toLowerCase().slice(0, 6)}
                <span data-part="address-middle">{wallet.address.toLowerCase().slice(6, -4)}</span>
                <span data-part="address-end">{wallet.address.toLowerCase().slice(-4)}</span>
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
              <Button tone="secondary" onClick={() => void wallet.switchNetwork()}>
                {t('Switch network')}
              </Button>
            </p>
          ) : null}
          <div className="lt-actions">
            <Button tone="secondary" onClick={wallet.disconnect}>
              {t('Disconnect')}
            </Button>
          </div>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p className="lt-hint">{t('No wallet')}</p>
      ) : (
        <div className="lt-actions">
          {wallet.wallets.map((entry) => (
            <Button
              key={entry.info.uuid}
              tone="secondary"
              disabled={wallet.status === 'connecting'}
              onClick={() => void wallet.connect(entry)}
            >
              {t('Connect wallet', { name: entry.info.name })}
            </Button>
          ))}
        </div>
      )}
      {wallet.problem ? (
        <p className="lt-refusal" role="alert">
          {wallet.problem}
        </p>
      ) : null}
    </section>
  );
}
