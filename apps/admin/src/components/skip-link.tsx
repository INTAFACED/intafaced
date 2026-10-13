'use client';
import { usePathname } from 'next/navigation';

/**
 * "Skip to enquiries": the first Tab stop on the CRM page, before the brand, the nav and Sign out. It is hidden by the stylesheet
 * while a tool view (where the enquiry list is not on screen) is open: the workspace sets `data-crm-view` on the body. On a phone
 * showing one enquiry the list is hidden, so the link moves focus to that enquiry's heading instead.
 */
export function SkipLink() {
  const pathname = usePathname();
  if (pathname !== '/crm') return null;
  return (
    <a
      className="adm-skip-link"
      href="#crm-enquiries"
      onClick={(event) => {
        event.preventDefault();
        // The list, or on a phone showing one enquiry (where the list is hidden) that enquiry's heading.
        const shown = (element: HTMLElement | null) => (element && element.getClientRects().length > 0 ? element : null);
        (shown(document.getElementById('crm-enquiries')) ?? shown(document.getElementById('crm-detail-heading')))?.focus();
      }}
    >
      Skip to enquiries
    </a>
  );
}
