import { Tabs } from '@intafaced/ui/lit/templates';
import { promotionsCopy as copy } from './promotions-copy';

export type PromotionsView = 'overview' | 'link' | 'records' | 'points' | 'perks';
/** Each promotion address opens its own section; the bare address and the invitations address show both. */
export function promotionsViewFor(path: string): PromotionsView {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  if (clean === '/uc/promotion/points') return 'points';
  if (clean === '/uc/promotion/perks') return 'perks';
  return clean === '/uc/promotion/mycards' ? 'link' : clean === '/uc/promotion/mypromotion' ? 'records' : 'overview';
}
const promotionTabs: ReadonlyArray<{
  view: PromotionsView;
  href: string;
  label: 'tabOverview' | 'tabLink' | 'tabRecords' | 'tabPoints' | 'tabPerks';
}> = [
  { view: 'overview', href: '/uc/promotion', label: 'tabOverview' },
  { view: 'link', href: '/uc/promotion/mycards', label: 'tabLink' },
  { view: 'records', href: '/uc/promotion/mypromotion', label: 'tabRecords' },
  { view: 'points', href: '/uc/promotion/points', label: 'tabPoints' },
  { view: 'perks', href: '/uc/promotion/perks', label: 'tabPerks' },
];
/** The promotion rooms' sections, as the kit's room row: links, the open one marked current. */
export function PromotionTabs({ view }: { view: PromotionsView }) {
  const { t } = copy.useCopy();
  return (
    <Tabs
      label={t('tabsLabel')}
      current={promotionTabs.find((tab) => tab.view === view)!.href}
      items={promotionTabs.map((tab) => ({ label: t(tab.label), href: tab.href }))}
    />
  );
}
