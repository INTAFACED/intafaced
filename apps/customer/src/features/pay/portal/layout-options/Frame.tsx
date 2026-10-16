import type { ReactNode, MouseEvent } from 'react';
import { layoutCopy as c } from './copy';
import { LayoutNavigation } from './Navigation';
import { layoutHref, type PortalLayout } from './layout';
import './options.css';

export function LayoutFrame({
  layout,
  here,
  title,
  purpose,
  action,
  children,
}: {
  layout: PortalLayout;
  here: string;
  title: ReactNode;
  purpose: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = c.useCopy();
  // Keep the chosen preview across existing portal links, including forms and details.
  // This changes only the dev query parameter; the existing app router owns navigation.
  const preserve = (event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('/pay/')) anchor?.setAttribute('href', layoutHref(href, layout));
  };
  const dashboard = here === '/pay/merchant';
  return (
    <div
      className={`plo plo--${layout} ${dashboard ? 'plo--dashboard' : 'plo--list'} ${here === '/pay/payments' ? 'plo--payments' : ''}`}
      onClickCapture={preserve}
    >
      <LayoutNavigation key={here} layout={layout} here={here} />
      <div className="plo-content pp">
        <header className="plo-heading">
          <div>
            <a href={layoutHref('/pay/merchant', layout)} className="plo-eyebrow">
              {t('portal')}
            </a>
            <h1>{dashboard ? t('overview') : title}</h1>
            <p>{dashboard ? t('purposes') : purpose}</p>
          </div>
          {!dashboard && action}
        </header>
        {here === '/pay/payments' && <p className="plo-list-gap">{t('listGap')}</p>}
        {children}
      </div>
    </div>
  );
}
