import type { ComponentProps } from 'react';
import './ui-kit.css';

/**
 * Wrapper for every screen built with the shared UI kit (`@intafaced/ui`). Rendering it is what brings in the kit's
 * stylesheet (`ui-kit.css`), so a page that never renders one gets no Tailwind CSS at all. The class `ui-scope` is the
 * hook for the kit's small reset (see `ui-kit.css`); it does not reach any element outside this wrapper, except the
 * kit's own popups, which carry `data-slot`.
 *
 * Put Tailwind classes only in files under `components/crm2/`; that folder is the only place the stylesheet scans.
 */
export function UiScope({ className, ...props }: ComponentProps<'div'>) {
  return <div data-ui-scope="" className={className ? `ui-scope ${className}` : 'ui-scope'} {...props} />;
}
