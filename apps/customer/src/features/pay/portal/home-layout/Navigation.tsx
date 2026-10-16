import { useEffect, useRef } from 'react';
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@intafaced/ui';
import { layoutCopy as c } from './copy';

type Key = Exclude<Parameters<typeof c.t>[0], 'paymentReference'>;
export const groups: { label: Key; items: [string, Key][] }[] = [
  {
    label: 'overview',
    items: [
      ['/pay/merchant', 'summary'],
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

export function activeGroup(here: string) {
  return groups.find((g) => g.items.some(([href]) => here === href || here.startsWith(href + '/'))) ?? groups[0]!;
}
export function GroupedMenu({ here, close }: { here: string; close?: () => void }) {
  const { t } = c.useCopy();
  return (
    <nav className="plo-grouped" aria-label={t('portal')}>
      <Accordion>
        {groups.map((group) => (
          <AccordionItem key={group.label} value={group.label}>
            <AccordionTrigger>{t(group.label)}</AccordionTrigger>
            <AccordionPanel>
              {group.items.map(([href, label]) => (
                <a href={href} key={href} aria-current={here === href ? 'page' : undefined} onClick={close}>
                  {t(label)}
                </a>
              ))}
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </nav>
  );
}
export function LayoutNavigation({ here }: { here: string }) {
  const { t } = c.useCopy();
  const active = activeGroup(here);
  const nav = useRef<HTMLDivElement>(null);
  useEffect(() => {
    nav.current?.querySelectorAll('[aria-current]').forEach((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [here]);
  return (
    <div ref={nav} className="plo-navigation">
      <nav className="plo-tabs" aria-label={t('portal')}>
        {groups.map((group) => (
          <a key={group.label} href={group.items[0]![0]} aria-current={group === active ? 'true' : undefined}>
            {t(group.label)}
          </a>
        ))}
      </nav>
      <nav className="plo-subtabs" aria-label={t(active.label)}>
        {active.items.map(([href, label]) => (
          <a key={href} href={href} aria-current={here === href ? 'page' : undefined}>
            {t(label)}
          </a>
        ))}
      </nav>
    </div>
  );
}
