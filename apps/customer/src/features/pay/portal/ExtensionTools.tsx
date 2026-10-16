import { useState, type ReactNode } from 'react';
import { Button } from '../../../shared/ui';
import { ComingSoon } from './components';
import { extensionCopy as c } from './extension-copy';

export function Arrives({ children }: { children: ReactNode }) {
  return <ComingSoon title={c.t('arrives')}>{children}</ComingSoon>;
}
export function PortalBack({ href = '/pay/merchant', children }: { href?: string; children?: ReactNode }) {
  return (
    <a className="text-link" href={href}>
      {children ?? c.t('backHome')}
    </a>
  );
}
export function CopyReference({ value }: { value: string }) {
  const [state, setState] = useState<'copy' | 'copied' | 'copyFailed'>('copy');
  return (
    <div className="pp-actions">
      <code className="pp-wrap">{value}</code>
      <Button
        variant="ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('copyFailed');
          }
        }}
      >
        {c.t('copy')}
      </Button>
      <span role="status">{state === 'copy' ? '' : c.t(state)}</span>
    </div>
  );
}
