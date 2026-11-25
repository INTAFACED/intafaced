// volt-room: /p2p/methods
import { SettingsTemplate } from '@intafaced/ui/lit/templates';
import { payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { METHODS_SECTIONS, PaymentMethods } from './PaymentMethods';
import { methodsCopy } from './payment-methods-copy';

/**
 * P2P payment methods on the settings template (J-p2p-04): the P2P rooms above, the index holds this room's sections; the
 * sections are the catalogue, adding a method and the ones the person holds.
 */
export function MethodsRoom({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { t } = methodsCopy.useCopy();
  const sections = [
    [METHODS_SECTIONS.catalogue, t('catalogueTitle')],
    [METHODS_SECTIONS.add, t('addTitle')],
    [METHODS_SECTIONS.saved, payCopy.t('yourPaymentDestinationLabels')],
  ] as const;
  return (
    <SettingsTemplate
      title={payCopy.t('personToPerson')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      section={<P2PTabs />}
      state={{ kind: 'ready' }}
      index={
        <>
          <nav aria-label={t('sectionsLabel')}>
            <ul>
              {sections.map(([id, title]) => (
                <li key={id}>
                  <a className="lt-link" href={`#${id}`}>
                    {title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </>
      }
      sections={<PaymentMethods pay={pay} userId={userId} />}
      explain={<p>{t('explain')}</p>}
    />
  );
}
