import { QrCode } from '@intafaced/ui/lit/templates';
import { CopyReference } from '../volt/parts';
import { paymentsCopy as c } from './copy';

/** Only ordinary web addresses are ever made clickable. */
export const isWebAddress = (value: string) => /^https?:\/\//i.test(value);

/** A QR code for a checkout address: dark on white in every theme, because that is what a scanner needs. */
export function AddressQr({ value }: { value: string }) {
  const { t } = c.useCopy();
  return <QrCode value={value} label={t('lk_qrLabel')} failed={t('lk_qrFailed')} size="sm" />;
}

/** The checkout address of a payment link, with the three things a merchant does with it: copy it, open it, scan it. */
export function LinkAddress({ url }: { url: string }) {
  const { t } = c.useCopy();
  return (
    <div className="lt-stack" data-testid="link-address">
      <CopyReference value={url} what={t('lk_addressWhat')} />
      {isWebAddress(url) && (
        <div className="lt-actions">
          <a className="lt-button lt-button-secondary" href={url} target="_blank" rel="noopener noreferrer">
            {t('lk_open')}
          </a>
        </div>
      )}
      <AddressQr value={url} />
    </div>
  );
}
