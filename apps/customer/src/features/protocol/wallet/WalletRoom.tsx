import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field, Page, Panel, Tabs } from '../../../shared/ui';
import { createProtocolApi } from '../api';
import { networkLabel, type ProtocolSnapshot } from '../blockers';
import { protocolCopy } from '../copy';
import { Actions, toSource } from '../ParkedProtocolRoom';
import '../protocol.css';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, shortAddress } from './eip1193';
import { useWallet } from './WalletProvider';

const SECTIONS = ['overview', 'activity', 'approvals', 'sessionKeys', 'accounts', 'safety'] as const;
type Section = (typeof SECTIONS)[number];
const HEADERS = {
  activity: ['hdr_time', 'hdr_event', 'hdr_status'],
  approvals: ['hdr_token', 'hdr_spender', 'hdr_allowance'],
  sessionKeys: ['hdr_name', 'hdr_address', 'hdr_status'],
  accounts: ['hdr_name', 'hdr_address', 'hdr_status'],
  safety: ['hdr_event', 'hdr_status'],
} as const;

/** The remote-connect relay project id is an owner setting. Blank hides the QR path and shows owner.decision. */
const relayProjectId: string = ((import.meta.env.VITE_WALLET_RELAY_PROJECT_ID as string | undefined) ?? '').trim();

/**
 * /wallet: connect, the connected wallet, the network guard and the six sections. A section that a later slice builds
 * shows its full layout and its real state (nothing to show, or what it needs), never a blank.
 */
export function WalletRoom({ section: initial }: { section: 'overview' | 'activity' }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { t: tp } = protocolCopy.forLocale(language);
  const wallet = useWallet();
  const [section, setSection] = useState<Section>(initial);
  useEffect(() => setSection(initial), [initial]);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const chain = useResource((signal) => api.chainStatus(signal), 'wallet-room:chain');
  const health = useResource((signal) => api.health(signal), 'wallet-room:health');
  const loading = { status: 'loading' as const };
  const snapshot: ProtocolSnapshot = { chain: toSource(chain), health: toSource(health), audit: loading, indexer: loading, dex: loading };
  const label = networkLabel(APP_CHAIN_ID);

  const connectPanel: ReactNode =
    wallet.status === 'connected' && wallet.address && wallet.connected ? (
      <Panel title={t('walletName')}>
        <dl className="protocol-facts">
          <div>
            <dt>{t('walletName')}</dt>
            <dd>
              {wallet.connected.info.icon && <img src={wallet.connected.info.icon} alt="" width={20} height={20} />}{' '}
              {wallet.connected.info.name}
            </dd>
          </div>
          <div>
            <dt>{t('connectedAs')}</dt>
            <dd className="numeric" data-wallet-address>
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
        {wallet.guard && !wallet.guard.ok && <Button onClick={() => void wallet.switchNetwork()}>{t('switchNetwork')}</Button>}{' '}
        <Button variant="secondary" onClick={wallet.disconnect}>
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
          <ul className="protocol-actions">
            {wallet.wallets.map((entry) => (
              <li key={entry.info.uuid}>
                <Button disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
                  {entry.info.icon && <img src={entry.info.icon} alt="" width={20} height={20} />}{' '}
                  {t('connectButton', { name: entry.info.name })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div data-code="owner.decision" role="note">
          <strong>{t('remoteTitle')}</strong>
          <p className="muted">{relayProjectId ? t('remoteNotBuilt') : t('remoteBlocked')}</p>
        </div>
        {wallet.problem && (
          <p role="status" data-wallet-problem>
            {wallet.problem}
          </p>
        )}
      </Panel>
    );

  const overview = (
    <>
      {connectPanel}
      <Panel title={t('enableTitle')}>
        <p className="muted">{t('enableNote')}</p>
        <Button variant="secondary" disabled aria-disabled="true" title={t('enableBlocked')}>
          {t('enableTitle')}
        </Button>
        <p className="protocol-actions__reason" role="note" data-blocker="dex_auth">
          {t('enableBlocked')}
        </p>
      </Panel>
      <Actions actions={['smartAccount']} snapshot={snapshot} t={tp} />
      <Panel title={t('keysTitle')}>
        <p className="muted">{t('keysNote')}</p>
        <p className="muted">
          <strong>{t('linkTitle')}.</strong> {t('linkNote')}
        </p>
      </Panel>
    </>
  );

  const body =
    section === 'overview' ? (
      overview
    ) : (
      <Panel title={t(`section_${section}`)}>
        {wallet.status !== 'connected' && <p className="muted">{t('needsWallet')}</p>}
        <DataTable label={t(`section_${section}`)} headers={HEADERS[section].map((key) => t(key))}>
          <tr>
            <td colSpan={HEADERS[section].length}>
              <EmptyState title={t(`empty_${section}`)} />
            </td>
          </tr>
        </DataTable>
      </Panel>
    );

  return (
    <div className="legacy-room protocol-room" lang={walletCopy.forLocale(language).renderedLocale} data-route="wallet">
      <Page
        title={t('title')}
        description={t('description')}
        eyebrow={
          <>
            <span>{t('bannerLine')}</span>
            <span className="badge protocol-pill">{tp('bannerPill')}</span>
          </>
        }
      >
        <Tabs
          label={t('sections')}
          items={SECTIONS}
          value={section}
          onChange={(next) => {
            const value = next as Section;
            if (value === 'overview' || value === 'activity') navigate(value === 'overview' ? '/wallet' : '/wallet/activity');
            else setSection(value);
          }}
          labels={Object.fromEntries(SECTIONS.map((id) => [id, t(`section_${id}`)]))}
        />
        {body}
      </Page>
    </div>
  );
}
