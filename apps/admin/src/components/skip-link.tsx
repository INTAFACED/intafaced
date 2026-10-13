'use client';
import { usePathname } from 'next/navigation';

/**
 * "Skip to enquiries": the first Tab stop on the CRM page, before the brand, the nav and Sign out. It is hidden by the stylesheet
 * while a tool view (where the enquiry list is not on screen) is open: the workspace sets `data-crm-view` on the body.
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
        document.getElementById('crm-enquiries')?.focus();
      }}
    >
      Skip to enquiries
    </a>
  );
}
