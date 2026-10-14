'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { skipLabel, skipTarget, type SkipTarget } from '@/lib/crm-skip-link';

/**
 * "Skip to enquiries": the first Tab stop on the CRM page, before the brand, the nav and Sign out. It is hidden by the stylesheet
 * while a tool view (where the enquiry list is not on screen) is open: the workspace sets `data-crm-view` on the body. On a phone
 * showing one enquiry the list is hidden, so the link moves focus to that enquiry's heading instead and says "Skip to enquiry".
 */
function currentTarget(): { target: SkipTarget | null; element: HTMLElement | null } {
  const shown = (element: HTMLElement | null) => (element && element.getClientRects().length > 0 ? element : null);
  const list = shown(document.getElementById('crm-enquiries'));
  const heading = shown(document.getElementById('crm-detail-heading'));
  const target = skipTarget(Boolean(list), Boolean(heading));
  return { target, element: target === 'list' ? list : target === 'detail' ? heading : null };
}

export function SkipLink() {
  const pathname = usePathname();
  const onCrm = pathname === '/crm';
  const [target, setTarget] = useState<SkipTarget | null>(null);
  useEffect(() => {
    if (!onCrm) return;
    // The workspace tells the body which view and whether one enquiry is open; the list is hidden by CSS at phone width.
    const update = () => requestAnimationFrame(() => setTarget(currentTarget().target));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-crm-view', 'data-crm-detail'] });
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [onCrm]);
  if (!onCrm) return null;
  return (
    <a
      className="adm-skip-link"
      href="#crm-enquiries"
      onClick={(event) => {
        event.preventDefault();
        currentTarget().element?.focus();
      }}
    >
      {skipLabel(target)}
    </a>
  );
}
