import { useRef, useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';
import { Button, PAY_QR_KEY_UNSET, requestPath, Skeleton, StateBlock, useSession, useToast } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import { QrCode } from './QrCode';
import { HandleSettings } from './HandleSettings';
import { usePayQr, type IdentityState, type PayQrState } from './identity-state';

/** Receive (UI-SPEC 5.10): the customer's @handle to share, or their Account ID until handles are live, with a QR code and a link. */
export function ReceiveCard({ identity, payQr }: { identity: IdentityState; payQr?: PayQrState }) {
  const { api, userId } = useSession();
  // A caller that already holds the code passes it in, and nothing is fetched twice.
  const read = usePayQr(api, payQr ? null : userId, identity.status === 'handles' ? identity.handle : '');
  const qr = payQr ?? read;
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
  // The link and the QR code carry the signed pay code, so a scan pays this account even when its handle can't be found.
  const link = absoluteLink(requestPath({ to: byHandle ? identity.handle : (userId ?? ''), qr: qr.kind === 'ok' ? qr.payload : null }));

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
        {qr.kind === 'loading' ? (
          <div aria-busy="true" data-testid="receive-qr-loading">
            <Skeleton height="10rem" width="10rem" />
            <Skeleton height="1.25rem" />
          </div>
        ) : (
          <>
            {qr.kind === 'ok' ? (
              <QrCode value={link} />
            ) : qr.kind === 'unset' ? (
              <StateBlock kind="refused" title={t('qrUnsetTitle')} body={t('qrUnsetBody')} code={PAY_QR_KEY_UNSET} />
            ) : (
              <StateBlock kind="error" title={t('qrLoadFailed')} onRetry={qr.retry} retryLabel={payCopy.t('Retry')} />
            )}
            <p className="pay-link" data-testid="receive-link-value" aria-label={t('yourLink')}>
              {link}
            </p>
          </>
        )}
        <p className="pay-hint">{t('receiveLinkHint')}</p>
        {failed === 'link' ? (
          <p className="pay-problem" role="alert">
            {t('copyLinkFailed')}
          </p>
        ) : null}
        <div className="pay-row-actions">
          <Button variant="secondary" size={40} disabled={qr.kind === 'loading'} onClick={() => void copy('link')}>
            <Link2 size={16} aria-hidden="true" />
            {t('copyLink')}
          </Button>
          {canShare() ? (
            <Button variant="secondary" size={40} disabled={qr.kind === 'loading'} onClick={() => void share()}>
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
