import { QrCode as KitQrCode } from '@intafaced/ui/lit/templates';
import { personalCopy } from './personal-copy';

/** A QR code for a payment link: the kit's code, dark on a light ground in every theme, because that is what a scanner needs. */
export function QrCode({ value }: { value: string }) {
  const { t } = personalCopy.useCopy();
  return <KitQrCode value={value} label={t('qrLabel')} failed={t('qrFailed')} marks={{ 'data-testid': 'pay-qr' }} />;
}
