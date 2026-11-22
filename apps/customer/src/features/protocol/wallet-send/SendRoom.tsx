import { Button, EmptyState, Field, Tag } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { networkLabel } from '../blockers';
import { protocolCopy } from '../copy';
import { WALLET_SECTIONS, type WalletSection } from '../routes';
import { walletCopy } from '../wallet/copy';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { useWallet } from '../wallet/WalletProvider';
import { SendPanel } from './SendPanel';

const SECTIONS = Object.keys(WALLET_SECTIONS) as WalletSection[];

/** The remote-connect relay project id is an owner setting. Blank hides the QR path and shows owner.decision. */
const relayProjectId: string = ((import.meta.env.VITE_WALLET_RELAY_PROJECT_ID as string | undefined) ?? '').trim();

/**
 * /wallet/send, on the flow template: the wallet's sections above, then the connected wallet (or the wallets to connect)
 * and Send (D-portfolio-wallet-03). A link that opens Send filled in (Home's pay-in route, a scanned code) may land here
 * before any wallet is connected, so the connection comes first, as it did in the wallet room.
 */
export function SendRoom() {
  const { language } = usePreferences();
  const { t, renderedLocale } = walletCopy.forLocale(language);
  const { t: tp } = protocolCopy.forLocale(language);
  const wallet = useWallet();
  // The room re-renders on every navigation (its path comes from the location), so the query is read as it renders.
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const label = networkLabel(APP_CHAIN_ID);

  const connection =
    wallet.status === 'connected' && wallet.address && wallet.connected ? (
      <section>
        <h2>{t('walletName')}</h2>
        <KeyValue
          rows={[
            {
              label: t('walletName'),
              value: (
                <>
                  {wallet.connected.info.icon && <img src={wallet.connected.info.icon} alt="" width={20} height={20} />}{' '}
                  {wallet.connected.info.name}
                </>
              ),
            },
            { label: t('connectedAs'), value: <span data-wallet-address>{wallet.address}</span>, ltr: true },
            {
              label: t('networkTitle'),
              value: (
                <span data-wallet-network={wallet.guard?.ok ? 'ok' : 'chain_mismatch'}>
                  {wallet.guard?.ok ? t('networkOk', { name: label.name, note: label.note }) : t('networkWrong', { name: label.name })}
                </span>
              ),
            },
          ]}
        />
        <div className="lt-actions">
          {wallet.guard && !wallet.guard.ok && (
            <Button tone="primary" onClick={() => void wallet.switchNetwork()}>
              {t('switchNetwork')}
            </Button>
          )}
          <Button tone="secondary" onClick={wallet.disconnect}>
            {t('disconnect')}
          </Button>
        </div>
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
      </section>
    ) : (
      <section>
        <h2>{t('connectTitle')}</h2>
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
      </section>
    );

  return (
    <div lang={renderedLocale} data-route="wallet">
      <FlowTemplate
        title={t('title')}
        description={t('description')}
        state={{ kind: 'ready' }}
        step={
          <>
            <SectionTabs
              label={t('sections')}
              items={SECTIONS.map((id) => ({ value: id, label: t(`section_${id}`) }))}
              value="send"
              onChange={(next) => navigate(WALLET_SECTIONS[next])}
            />
            {connection}
            <SendPanel to={query.get('to') ?? ''} token={query.get('token') ?? ''} />
          </>
        }
        summary={
          <p>
            {t('bannerLine')} <Tag>{tp('bannerPill')}</Tag>
          </p>
        }
      />
    </div>
  );
}
