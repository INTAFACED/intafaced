import { Button, Field } from '@intafaced/ui/lit';
import { usePreferences } from '../../../shared/preferences';
import { networkLabel } from '../blockers';
import { EmptyState, Panel } from '../volt/parts';
import { walletCopy } from './copy';
import { APP_CHAIN_ID } from './eip1193';
import { useWallet } from './WalletProvider';

/** The remote-connect relay project id is an owner setting. Blank hides the QR path and shows owner.decision. */
const relayProjectId: string = ((import.meta.env.VITE_WALLET_RELAY_PROJECT_ID as string | undefined) ?? '').trim();

/**
 * The wallet room's connect panel, drawn only from the Volt kit: the wallets this browser offers, or the connected
 * wallet with its address, the network guard, Disconnect and the idle lock.
 */
export function ConnectPanel() {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const label = networkLabel(APP_CHAIN_ID);
  return wallet.status === 'connected' && wallet.address && wallet.connected ? (
    <Panel title={t('walletName')}>
      <dl className="lt-kv">
        <div>
          <dt>{t('walletName')}</dt>
          <dd>
            {wallet.connected.info.icon && <img src={wallet.connected.info.icon} alt="" width={20} height={20} />}{' '}
            {wallet.connected.info.name}
          </dd>
        </div>
        <div>
          <dt>{t('connectedAs')}</dt>
          <dd className="lt-mono" data-wallet-address>
            {wallet.address}
          </dd>
        </div>
        <div>
          <dt>{t('networkTitle')}</dt>
          <dd data-wallet-network={wallet.guard?.ok ? 'ok' : 'chain_mismatch'}>
            {wallet.guard?.ok ? t('networkOk', { name: label.name, note: label.note }) : t('networkWrong', { name: label.name })}
          </dd>
        </div>
      </dl>
      {wallet.guard && !wallet.guard.ok && (
        <Button tone="primary" onClick={() => void wallet.switchNetwork()}>
          {t('switchNetwork')}
        </Button>
      )}{' '}
      <Button tone="secondary" onClick={wallet.disconnect}>
        {t('disconnect')}
      </Button>
      <Field
        label={t('idleLabel')}
        hint={t('idleHint')}
        inputMode="numeric"
        value={wallet.idleMinutes === null ? '' : String(wallet.idleMinutes)}
        onChange={(event) => {
          const text = event.target.value.trim();
          wallet.setIdleMinutes(/^[1-9]\d{0,4}$/.test(text) ? Number(text) : null);
        }}
      />
    </Panel>
  ) : (
    <Panel title={t('connectTitle')}>
      {wallet.wallets.length === 0 ? (
        <EmptyState title={t('connectNone')} />
      ) : (
        <ul className="lt-actions">
          {wallet.wallets.map((entry) => (
            <li key={entry.info.uuid}>
              <Button tone="primary" disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
                {entry.info.icon && <img src={entry.info.icon} alt="" width={20} height={20} />}{' '}
                {t('connectButton', { name: entry.info.name })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div data-code="owner.decision" role="note">
        <strong>{t('remoteTitle')}</strong>
        <p className="lt-hint">{relayProjectId ? t('remoteNotBuilt') : t('remoteBlocked')}</p>
      </div>
      {wallet.problem && (
        <p role="status" data-wallet-problem>
          {wallet.problem}
        </p>
      )}
    </Panel>
  );
}
