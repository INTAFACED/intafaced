import { useMemo } from 'react';
import { Button } from '@intafaced/ui';
import { encodeQr, qrPath } from '../../personal/qr';
import { CopyReference } from '../ui/CopyReference';
import { paymentsCopy as c } from './copy';

/** Only ordinary web addresses are ever made clickable. */
export const isWebAddress = (value: string) => /^https?:\/\//i.test(value);

/** A QR code for a checkout address: dark on white in every theme, because that is what a scanner needs. */
export function AddressQr({ value }: { value: string }) {
  const { t } = c.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  if (!drawn) return <p className="muted">{t('lk_qrFailed')}</p>;
  return (
    <svg
      viewBox={`0 0 ${drawn.size} ${drawn.size}`}
      role="img"
      aria-label={t('lk_qrLabel')}
      shapeRendering="crispEdges"
      width={176}
      height={176}
      style={{ background: '#fff', borderRadius: 8, maxWidth: '100%' }}
    >
      <path d={drawn.d} fill="#000" />
    </svg>
  );
}

/** The checkout address of a payment link, with the three things a merchant does with it: copy it, open it, scan it. */
export function LinkAddress({ url }: { url: string }) {
  const { t } = c.useCopy();
  return (
    <div className="stack" data-testid="link-address">
      <CopyReference value={url} what={t('lk_addressWhat')} />
      <div className="pp-actions">
        {isWebAddress(url) && (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href={url} target="_blank" rel="noopener noreferrer" />}>
            {t('lk_open')}
          </Button>
        )}
      </div>
      <AddressQr value={url} />
    </div>
  );
}
