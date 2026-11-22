import { useMemo, useRef, useState } from 'react';
import { Copy, Link2, Share2 } from 'lucide-react';
import { Button, EmptyState, QrMark, RefusalBox, useToast } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { encodeQr, PAY_QR_KEY_UNSET, qrPath, requestPath, useSession } from './deps';
import { payCopy } from './copy';
import { personalCopy } from './personal-copy';
import { absoluteLink, canShare, copyText, shareLink } from './share';
import { HandleSettings } from './HandleSettings';
import { ReceiveContacts } from './ReceiveContacts';
import { StrangerRule } from './StrangerRule';
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
      <div className="lt-body" aria-busy="true" data-testid="receive-loading">
        <Skeleton shape="text" count={3} />
      </div>
    );
  if (identity.status === 'error')
    return (
      <div role="alert">
        <EmptyState
          title={payCopy.t('Couldn’t load your details')}
          action={
            <Button tone="secondary" onClick={identity.retry}>
              {payCopy.t('Retry')}
            </Button>
          }
        />
      </div>
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
    <div className="lt-body" data-testid="receive-card">
      <div className="lt-field">
        <h2 className="lt-hint">{byHandle ? payCopy.t('Your handle') : payCopy.t('Your account ID')}</h2>
        <p className="lt-title" data-mono={byHandle ? undefined : ''} data-testid="receive-value">
          {byHandle ? shown : <span className="lt-mono">{shown}</span>}
        </p>
        <p className="lt-hint">{byHandle ? payCopy.t('Receive tagline') : payCopy.t('Receive tagline account')}</p>
        {failed === 'value' ? <p role="alert">{payCopy.t('Copy failed')}</p> : null}
      </div>
      <Button tone="primary" size="lg" block onClick={() => void copy('value')} data-testid="receive-copy">
        <Copy size={18} aria-hidden="true" />
        {payCopy.t('Copy')}
      </Button>

      {identity.status === 'handles' ? <HandleSettings handle={identity.handle} onRenamed={(next) => identity.renamed?.(next)} /> : null}
      {identity.status === 'handles' ? <ReceiveContacts /> : null}
      <StrangerRule />

      <div className="lt-body" data-testid="receive-link">
        <h3 className="lt-title">{t('scanToPay')}</h3>
        {qr.kind === 'loading' ? (
          <div aria-busy="true" data-testid="receive-qr-loading">
            <Skeleton shape="figure" />
            <Skeleton shape="text" count={1} />
          </div>
        ) : (
          <>
            {qr.kind === 'ok' ? (
              <PayQr value={link} />
            ) : qr.kind === 'unset' ? (
              <RefusalBox refusal={{ variant: 'refused', title: t('qrUnsetTitle'), body: t('qrUnsetBody'), reference: PAY_QR_KEY_UNSET }} />
            ) : (
              <div role="alert">
                <EmptyState
                  title={t('qrLoadFailed')}
                  action={
                    <Button tone="secondary" onClick={qr.retry}>
                      {payCopy.t('Retry')}
                    </Button>
                  }
                />
              </div>
            )}
            <p className="lt-mono" data-testid="receive-link-value" aria-label={t('yourLink')}>
              {link}
            </p>
          </>
        )}
        <p className="lt-hint">{t('receiveLinkHint')}</p>
        {failed === 'link' ? <p role="alert">{t('copyLinkFailed')}</p> : null}
        <div className="lt-actions">
          <Button tone="secondary" disabled={qr.kind === 'loading'} onClick={() => void copy('link')}>
            <Link2 size={16} aria-hidden="true" />
            {t('copyLink')}
          </Button>
          {canShare() ? (
            <Button tone="secondary" disabled={qr.kind === 'loading'} onClick={() => void share()}>
              <Share2 size={16} aria-hidden="true" />
              {t('share')}
            </Button>
          ) : null}
          <a className="lt-link" href="/pay/request">
            {t('requestAnAmount')}
          </a>
        </div>
      </div>
    </div>
  );
}

/** A QR code for a payment link, drawn by the kit: encoded as QrCode.tsx encodes it (error correction M, scale 2). */
function PayQr({ value }: { value: string }) {
  const { t } = personalCopy.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  if (!drawn) return <p role="alert">{t('qrFailed')}</p>;
  return <QrMark d={drawn.d} size={drawn.size} label={t('qrLabel')} data-testid="pay-qr" />;
}
