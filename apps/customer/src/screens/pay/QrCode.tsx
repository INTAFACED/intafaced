import { useMemo } from 'react';
import { encodeQr, qrPath } from './deps';
import { personalCopy } from './personal-copy';

/** A QR code for a payment link. Dark on white in every theme, because that is what a scanner needs. */
export function QrCode({ value }: { value: string }) {
  const { t } = personalCopy.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  if (!drawn) return <p className="pay-problem">{t('qrFailed')}</p>;
  return (
    <div className="pay-qr" data-testid="pay-qr">
      <svg viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={t('qrLabel')} shapeRendering="crispEdges">
        <path d={drawn.d} fill="#000000" />
      </svg>
    </div>
  );
}
