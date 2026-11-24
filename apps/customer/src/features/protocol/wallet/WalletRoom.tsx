import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { Page, Tabs } from '../../../shared/ui';
import { protocolCopy } from '../copy';
import '../protocol.css';
import { walletCopy } from './copy';
import { ClaimLinksPanel } from './ClaimLinksPanel';
import { ConnectPanel } from './ConnectPanel';
import { WalletHomeRoom } from './WalletHomeRoom';
import { SafetyPanel } from './SafetyPanel';
import { ScanPanel } from './ScanPanel';
import { SendPanel } from './SendPanel';
import { WALLET_SECTIONS, type WalletSection, walletSections } from '../routes';

const SECTIONS = walletSections();
type Section = WalletSection;

/**
 * /wallet: connect, the connected wallet, the network guard and its sections, each at its own path. A section that a
 * later slice builds shows its full layout and its real state (nothing to show, or what it needs), never a blank.
 */
export function WalletRoom({ section: initial }: { section: Section }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { t: tp } = protocolCopy.forLocale(language);
  const section = initial;
  // The room re-renders on every navigation (its path comes from the location), so the query is read as it renders.
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const connectPanel = <ConnectPanel />;

  const body =
    section === 'send' ? (
      // A link that opens Send filled in (Home's pay-in route) may land here before any wallet is connected.
      <>
        {connectPanel}
        <SendPanel to={query.get('to') ?? ''} token={query.get('token') ?? ''} />
      </>
    ) : section === 'scan' ? (
      <ScanPanel />
    ) : section === 'claimLinks' ? (
      <ClaimLinksPanel />
    ) : null;

  // The overview is drawn on its own monitor template (features/protocol/wallet/WalletHomeRoom.tsx).
  if (section === 'overview') return <WalletHomeRoom />;
  // Safety is drawn on its own reading template, with the sections as links (features/protocol/wallet/SafetyPanel.tsx).
  if (section === 'safety') return <SafetyPanel />;
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
          onChange={(next) => navigate(WALLET_SECTIONS[next as Section])}
          labels={Object.fromEntries(SECTIONS.map((id) => [id, t(`section_${id}`)]))}
        />
        {body}
      </Page>
    </div>
  );
}
