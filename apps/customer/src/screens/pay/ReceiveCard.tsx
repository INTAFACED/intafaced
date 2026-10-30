import { useRef, useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';
import { Button, requestPath, Skeleton, StateBlock, useSession, useToast } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import { QrCode } from './QrCode';
import { HandleSettings } from './HandleSettings';
import type { IdentityState } from './identity-state';

/** Receive (UI-SPEC 5.10): the customer's @handle to share, or their Account ID until handles are live, with a QR code and a link. */
export function ReceiveCard({ identity }: { identity: IdentityState }) {
  const { userId } = useSession();
  const toast = useToast();
  const [failed, setFailed] = useState<'value' | 'link' | null>(null);
  const attempt = useRef(0);
  const { t } = personalCopy.useCopy();

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
  const link = absoluteLink(requestPath({ to: byHandle ? identity.handle : (userId ?? '') }));

  async function copy(what: 'value' | 'link') {
    const mine = ++attempt.current;
    setFailed(null);
    const ok = await copyText(what === 'value' ? shown : link);
    if (attempt.current !== mine) return;
    if (ok) toast.add({ title: what === 'value' ? payCopy.t('Copied') : t('linkCopied'), timeout: 2000 });
    else setFailed(what);
  }
  async function share() {
    const result = await shareLink(link, t('shareTitle'));
    if (result === 'failed') await copy('link');
  }

  return (
    <div className="pay-body" data-testid="receive-card">
      <div className="pay-receive">
        <h2 className="pay-receive__label">{byHandle ? payCopy.t('Your handle') : payCopy.t('Your account ID')}</h2>
        <p className="pay-receive__value" data-mono={byHandle ? undefined : ''} data-testid="receive-value">
          {shown}
        </p>
        <p className="pay-receive__hint">{byHandle ? payCopy.t('Receive tagline') : payCopy.t('Receive tagline account')}</p>
        {failed === 'value' ? (
          <p className="pay-problem" role="alert">
            {payCopy.t('Copy failed')}
          </p>
        ) : null}
      </div>
      <Button variant="primary" size={56} fullWidth onClick={() => void copy('value')} data-testid="receive-copy">
        <Copy size={18} aria-hidden="true" />
        {payCopy.t('Copy')}
      </Button>

      {identity.status === 'handles' ? <HandleSettings handle={identity.handle} onRenamed={(next) => identity.renamed?.(next)} /> : null}

      <div className="pay-block" data-testid="receive-link">
        <h3 className="pay-section-title">{t('scanToPay')}</h3>
        <QrCode value={link} />
        <p className="pay-link" data-testid="receive-link-value" aria-label={t('yourLink')}>
          {link}
        </p>
        <p className="pay-hint">{t('receiveLinkHint')}</p>
        {failed === 'link' ? (
          <p className="pay-problem" role="alert">
            {t('copyLinkFailed')}
          </p>
        ) : null}
        <div className="pay-row-actions">
          <Button variant="secondary" size={40} onClick={() => void copy('link')}>
            <Link2 size={16} aria-hidden="true" />
            {t('copyLink')}
          </Button>
          {canShare() ? (
            <Button variant="secondary" size={40} onClick={() => void share()}>
              <Share2 size={16} aria-hidden="true" />
              {t('share')}
            </Button>
          ) : null}
          <Button variant="ghost" size={40} nativeButton={false} render={<a href="/pay/request" role="link" />}>
            {t('requestAnAmount')}
          </Button>
        </div>
      </div>
    </div>
  );
}
