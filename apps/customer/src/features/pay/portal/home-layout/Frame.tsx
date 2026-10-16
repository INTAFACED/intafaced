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
    <div className={`plo ${dashboard ? 'plo--dashboard' : 'plo--list'} ${here === '/pay/payments' ? 'plo--payments' : ''}`}>
      <LayoutNavigation key={here} here={here} />
      <div className="plo-content pp">
        {dashboard ? (
          <h1 className="pp-sr">{t('portal')}</h1>
        ) : (
          <header className="plo-heading">
            <div>
              <a href="/pay/merchant" className="plo-eyebrow">
                {t('portal')}
              </a>
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
