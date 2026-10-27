import type { ReactNode } from 'react';
import { layoutCopy as c } from './copy';
import { LayoutNavigation } from './Navigation';
import './home-layout.css';

export function LayoutFrame({
  here,
  title,
  purpose,
  action,
  children,
}: {
  here: string;
  title: ReactNode;
  purpose?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { t } = c.useCopy();
  const dashboard = here === '/pay/merchant';
  return (
    <div className={`plo pfo-tabs ${dashboard ? 'plo--dashboard' : 'plo--list'} ${here === '/pay/payments' ? 'plo--payments' : ''}`}>
      <LayoutNavigation key={here} here={here} />
      <div data-testid="pp" className="plo-content pp">
        {dashboard ? (
          <h1 className="pp-sr">{t('overviewHeading')}</h1>
        ) : (
          <header data-testid="plo-heading" className="plo-heading">
            <div>
              <h1>{title}</h1>
              {purpose && <p>{purpose}</p>}
            </div>
            {action}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}
