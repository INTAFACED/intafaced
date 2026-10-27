import { useEffect, useRef } from 'react';
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@intafaced/ui';
import { useOptionalMerchantAccess } from '../access/MerchantAccess';
import { layoutCopy as c } from './copy';

import { groups, type NavGroup, type NavItem } from './groups';

const matchOf = ([href, , options]: NavItem) => options?.match ?? href;
const covers = (prefix: string, here: string) => here === prefix || here.startsWith(prefix + '/');

/** The one menu item that matches this page: the longest address it sits under. Hidden items still count, so a page stays in its tab. */
export function currentItem(here: string): { group: NavGroup; item: NavItem } | undefined {
  let best: { group: NavGroup; item: NavItem; length: number } | undefined;
  for (const group of groups)
    for (const item of group.items) {
      const prefix = matchOf(item);
      if (covers(prefix, here) && (!best || prefix.length > best.length)) best = { group, item, length: prefix.length };
    }
  return best && { group: best.group, item: best.item };
}
export function activeGroup(here: string) {
  return currentItem(here)?.group ?? groups[0]!;
}

/** The groups this person sees: platform-only items drop out unless the business is a platform. */
export function useVisibleGroups(): NavGroup[] {
  const mode = useOptionalMerchantAccess()?.access;
  const payfac = mode?.status === 'ready' && mode.mode === 'payfac';
  return groups.map((group) => ({ ...group, items: group.items.filter(([, , options]) => options?.when !== 'payfac' || payfac) }));
}

export function GroupedMenu({ here, close }: { here: string; close?: () => void }) {
  const { t } = c.useCopy();
  const visible = useVisibleGroups();
  const current = currentItem(here)?.item;
  return (
    <nav className="plo-grouped" aria-label={t('portalNav')}>
      <Accordion>
        {visible.map((group) => (
          <AccordionItem key={group.label} value={group.label}>
            <AccordionTrigger>{t(group.label)}</AccordionTrigger>
            <AccordionPanel>
              {group.items.map((item) => (
                <a href={item[0]} key={item[0]} aria-current={current && current[0] === item[0] ? 'page' : undefined} onClick={close}>
                  {t(item[1])}
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
  const visible = useVisibleGroups();
  const active = activeGroup(here);
  const current = currentItem(here)?.item;
  const nav = useRef<HTMLDivElement>(null);
  useEffect(() => {
    nav.current?.querySelectorAll('[aria-current]').forEach((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [here]);
  const shown = visible.find((g) => g.label === active.label) ?? active;
  return (
    <div ref={nav} className="plo-navigation">
      <nav data-testid="plo-tabs" className="plo-tabs" aria-label={t('portalNav')}>
        {visible.map((group) => (
          <a key={group.label} href={group.items[0]![0]} aria-current={group.label === active.label ? 'true' : undefined}>
            {t(group.label)}
          </a>
        ))}
      </nav>
      <nav className="plo-subtabs" aria-label={t(active.label)}>
        {shown.items.map((item) => (
          <a key={item[0]} href={item[0]} aria-current={current && current[0] === item[0] ? 'page' : undefined}>
            {t(item[1])}
          </a>
        ))}
      </nav>
    </div>
  );
}
