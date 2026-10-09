import { Chip } from '@/components/chip';
import { consoleCopy, type ConsoleLocale } from '@/lib/console-copy';
import type { ConsoleStatus } from '@/lib/console-status';
import './module-state-inspector.css';
export interface ConsoleStatusBannerProps {
  status: ConsoleStatus;
  locale?: ConsoleLocale;
}
/** Transport presence never hides the unavailable-module boundary or grants human authority. */
export function ConsoleStatusBanner({ status, locale = 'en' }: ConsoleStatusBannerProps) {
  const copy = (key: string) => consoleCopy(key, {}, locale);
  const hasTransport = status.module.configured || status.treasury.configured;
  return (
    <div className="adm-alertstrip mi-console-boundary" data-severity={hasTransport ? 'partial' : 'none'} role="status">
      <Chip tone="dark">{copy('admin.console.transport.title')}</Chip>
      <div className="mi-boundary-body">
        <p className="mi-boundary-summary">{copy('admin.console.transport.compact.guards')}</p>
        <details className="mi-deployment">
          <summary>{copy('admin.console.transport.details')}</summary>
          <div className="mi-deployment-facts">
            <p>{copy('admin.console.transport.facts')}</p>
            {[status.module, status.treasury].map((authority) => (
              <p key={authority.authority}>
                {copy(`admin.console.transport.${authority.authority}`)}:{' '}
                {authority.configured ? (
                  copy('admin.console.transport.configured')
                ) : (
                  <>
                    {copy('admin.console.transport.missing')}{' '}
                    {authority.missing.map((name, i) => (
                      <span key={name}>
                        {i > 0 && ' + '}
                        <code>{name}</code>
                      </span>
                    ))}
                  </>
                )}
                .
              </p>
            ))}
            <p>
              {status.bffGated ? (
                copy('admin.console.transport.proxy.configured')
              ) : (
                <>
                  {copy('admin.console.transport.proxy.missing')} <code>ADMIN_BFF_SHARED_SECRET</code>.
                </>
              )}
            </p>
            <p>{copy('admin.console.transport.module.guards')}</p>
            <p>{copy('admin.console.transport.treasury.guards')}</p>
            <p>{copy('admin.console.transport.disclaimer')}</p>
          </div>
        </details>
      </div>
    </div>
  );
}
