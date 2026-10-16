import type { ReactNode } from 'react';
import { SideBar } from '../frame-options/Chrome';
import { frameOption } from '../frame-options/model';
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
  const side = frameOption(typeof location === 'undefined' ? '' : location.search) === 'side';
  const dashboard = here === '/pay/merchant';
  return (
    <div
      className={`plo ${side ? 'pfo-side' : 'pfo-tabs'} ${dashboard ? 'plo--dashboard' : 'plo--list'} ${here === '/pay/payments' ? 'plo--payments' : ''}`}
    >
      {side ? <SideBar here={here} /> : <LayoutNavigation key={here} here={here} />}
      <div className="plo-content pp">
        {dashboard ? (
          <h1 className="pp-sr">{t('portal')}</h1>
        ) : (
          <header className="plo-heading">
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
