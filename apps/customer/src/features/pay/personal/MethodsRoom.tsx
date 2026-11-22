import { SettingsTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { METHODS_SECTIONS, PaymentMethods } from './PaymentMethods';
import { methodsCopy } from './payment-methods-copy';

/** The P2P rooms, in the order the other P2P pages list them. */
const P2P_ROOMS = [
  ['/p2p', 'offers'],
  ['/uc/order', 'yourOrders'],
  ['/uc/ad', 'yourOffers'],
  ['/p2p/methods', 'paymentMethods'],
  ['/p2p/access', 'tradingAccess'],
] as const;

/**
 * P2P payment methods on the settings template (J-p2p-04): the index holds the P2P rooms and this room's sections; the
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
      state={{ kind: 'ready' }}
      index={
        <>
          <Tabs
            label={payCopy.t('p2pRooms')}
            current="/p2p/methods"
            items={P2P_ROOMS.map(([href, key]) => ({ href, label: payCopy.t(key) }))}
          />
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
