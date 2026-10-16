import { useState } from 'react';
import { ChevronDown, ArrowUpRight, Menu } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '@intafaced/ui';
import { layoutCopy as c } from './copy';
import { layoutHref, type PortalLayout } from './layout';

type Key = Parameters<typeof c.t>[0];
export const groups: { label: Key; items: [string, Key][] }[] = [
  {
    label: 'overview',
    items: [
      ['/pay/merchant', 'dashboard'],
      ['/pay/reports', 'reports'],
      ['/pay/onboarding', 'setup'],
    ],
  },
  {
    label: 'payments',
    items: [
      ['/pay/payments', 'paymentList'],
      ['/pay/links', 'links'],
      ['/pay/refunds', 'refunds'],
      ['/pay/disputes', 'disputes'],
      ['/pay/checkout', 'checkout'],
    ],
  },
  {
    label: 'moneyOut',
    items: [
      ['/pay/money', 'money'],
      ['/pay/payouts', 'payouts'],
      ['/pay/settlements', 'settlements'],
      ['/pay/conversion', 'conversion'],
      ['/pay/approvals', 'approvals'],
    ],
  },
  {
    label: 'billing',
    items: [
      ['/pay/customers', 'customers'],
      ['/pay/invoices', 'invoices'],
      ['/pay/subscriptions', 'subscriptions'],
      ['/pay/network', 'network'],
    ],
  },
  {
    label: 'settings',
    items: [
      ['/pay/settings', 'business'],
      ['/pay/developer', 'developers'],
      ['/pay/team', 'team'],
      ['/pay/permissions', 'permissions'],
      ['/pay/compliance', 'compliance'],
      ['/pay/pricing', 'pricing'],
      ['/pay/limits', 'limits'],
      ['/pay/notifications', 'notifications'],
      ['/pay/exports', 'exports'],
    ],
  },
];
export function GroupedMenu({ layout, here, close }: { layout: PortalLayout; here: string; close?: () => void }) {
  const { t } = c.useCopy();
  return (
    <nav className="plo-grouped" aria-label={t('portal')}>
      {groups.map((group) => (
        <details key={group.label}>
          <summary>
            {t(group.label)}
            <ChevronDown size={15} aria-hidden="true" />
          </summary>
          <div>
            {group.items.map(([href, label]) => (
              <a href={layoutHref(href, layout)} key={href} aria-current={here === href ? 'page' : undefined} onClick={close}>
                {t(label)}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}
export function LayoutNavigation({ layout, here }: { layout: PortalLayout; here: string }) {
  const { t } = c.useCopy();
  const [open, setOpen] = useState(false);
  const active = groups.find((g) => g.items.some(([href]) => here === href || here.startsWith(href + '/'))) ?? groups[0]!;
  return (
    <>
      {layout === 'b' ? (
        <aside className="plo-sidebar">
          <p>{t('business')}</p>
          <GroupedMenu layout={layout} here={here} />
        </aside>
      ) : (
        <nav className={`plo-tabs plo-tabs--${layout}`} aria-label={t('portal')}>
          {groups.map((group) => (
            <a key={group.label} href={layoutHref(group.items[0]![0], layout)} aria-current={group === active ? 'true' : undefined}>
              {t(group.label)}
            </a>
          ))}
        </nav>
      )}
      {layout === 'c' && (
        <nav className="plo-subtabs" aria-label={t(active.label)}>
          {active.items.map(([href, label]) => (
            <a key={href} href={layoutHref(href, layout)} aria-current={here === href ? 'page' : undefined}>
              {t(label)}
            </a>
          ))}
        </nav>
      )}
      <div className="plo-mobile-menu">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Menu size={18} aria-hidden="true" />
          {t('menu')}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="plo-mobile-dialog"
          style={{ top: 'auto', bottom: 16, left: 12, right: 12, transform: 'none', translate: 'none', width: 'calc(100vw - 24px)' }}
          closeLabel={t('close')}
        >
          <DialogTitle>{t('menu')}</DialogTitle>
          <DialogDescription>{t('menuBody')}</DialogDescription>
          <GroupedMenu layout={layout} here={here} close={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
