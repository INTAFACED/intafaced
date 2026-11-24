import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { WALLET_SECTIONS, type WalletSection, walletSections } from '../routes';
import { Tabs } from '../volt/parts';
import { walletCopy } from './copy';

const SECTIONS = walletSections();

/**
 * What a wallet section on the record-list template passes its template: the wallet's name and line, its sections (the
 * same pressed buttons the wallet room shows) and the wallet's parked line.
 */
export function useWalletFrame(section: WalletSection) {
  const { language } = usePreferences();
  const { t, renderedLocale } = walletCopy.forLocale(language);
  return {
    lang: renderedLocale,
    title: t('title'),
    description: t('description'),
    sections: (
      <Tabs
        label={t('sections')}
        items={SECTIONS}
        value={section}
        onChange={(next) => navigate(WALLET_SECTIONS[next as WalletSection])}
        labels={Object.fromEntries(SECTIONS.map((id) => [id, t(`section_${id}`)]))}
      />
    ),
    banner: (
      <p className="lt-hint">
        <span>{t('bannerLine')}</span>
      </p>
    ),
  };
}
