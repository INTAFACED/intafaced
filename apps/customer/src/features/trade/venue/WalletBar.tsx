import { Button } from '@intafaced/ui/lit';
import { useWallet } from '../../protocol';
import { venueCopy } from './venue-copy';

/**
 * The wallet that signs on the venue, drawn from the kit: the connected address and network with Disconnect, a
 * wrong-network warning with Switch network, or one Connect button per wallet this browser offers. Every desk and
 * room that signs on the venue shares this one drawing.
 */
export function WalletBar() {
  const { t } = venueCopy.useCopy();
  const wallet = useWallet();
  return (
    <section aria-label={t('Your wallet')} data-testid="venue-wallet">
      <h2>{t('Your wallet')}</h2>
      {wallet.status === 'connected' && wallet.address ? (
        <>
          <dl>
            <div>
              <dt>{t('Connected address')}</dt>
              <dd className="lt-mono" data-testid="venue-wallet-address">
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
              <Button tone="primary" onClick={() => void wallet.switchNetwork()}>
                {t('Switch network')}
              </Button>
            </p>
          ) : null}
          <Button tone="secondary" onClick={wallet.disconnect}>
            {t('Disconnect')}
          </Button>
        </>
      ) : wallet.wallets.length === 0 ? (
        <p className="lt-hint">{t('No wallet')}</p>
      ) : (
        wallet.wallets.map((entry) => (
          <Button tone="primary" key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
            {t('Connect wallet', { name: entry.info.name })}
          </Button>
        ))
      )}
      {wallet.problem ? <p role="alert">{wallet.problem}</p> : null}
    </section>
  );
}
