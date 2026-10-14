import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button, Skeleton, StateBlock, useSession, useToast } from './deps';
import { payCopy } from './copy';
import type { IdentityState } from './identity-state';

/** Receive (UI-SPEC 5.10): the customer's @handle to share, or their Account ID until handles are live. */
export function ReceiveCard({ identity }: { identity: IdentityState }) {
  const { userId } = useSession();
  const toast = useToast();
  const [failed, setFailed] = useState(false);
  const attempt = useRef(0);

  if (identity.status === 'loading')
    return (
      <div className="pay-body pay-body--skeleton" aria-busy="true" data-testid="receive-loading">
        <Skeleton height={28} width={140} />
        <Skeleton height={48} />
        <Skeleton height={40} width={120} />
      </div>
    );
  if (identity.status === 'error')
    return (
      <StateBlock kind="error" title={payCopy.t('Couldn’t load your details')} onRetry={identity.retry} retryLabel={payCopy.t('Retry')} />
    );

  const byHandle = identity.status === 'handles';
  const shown = byHandle ? `@${identity.handle}` : (userId ?? '');

  async function copy() {
    const mine = ++attempt.current;
    setFailed(false);
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(shown);
      if (attempt.current === mine) toast.add({ title: payCopy.t('Copied'), timeout: 2000 });
    } catch {
      if (attempt.current === mine) setFailed(true);
    }
  }

  return (
    <div className="pay-body" data-testid="receive-card">
      <div className="pay-receive">
        <h2 className="pay-receive__label">{byHandle ? payCopy.t('Your handle') : payCopy.t('Your account ID')}</h2>
        <p className="pay-receive__value" data-mono={byHandle ? undefined : ''} data-testid="receive-value">
          {shown}
        </p>
        <p className="pay-receive__hint">{byHandle ? payCopy.t('Receive tagline') : payCopy.t('Receive tagline account')}</p>
        {failed ? (
          <p className="pay-problem" role="alert">
            {payCopy.t('Copy failed')}
          </p>
        ) : null}
      </div>
      <Button variant="primary" size={56} fullWidth onClick={() => void copy()} data-testid="receive-copy">
        <Copy size={18} aria-hidden="true" />
        {payCopy.t('Copy')}
      </Button>
    </div>
  );
}
