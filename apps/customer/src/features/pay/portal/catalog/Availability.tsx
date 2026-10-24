import { useState } from 'react';
import { DataTable } from '@intafaced/ui';
import type { MerchantProduct } from '@intafaced/contracts/merchant-catalog';
import { SALE_CHANNELS, type ProductAvailability, type SaleChannel } from '@intafaced/contracts/merchant-stores';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import type { PortalApi } from '../api';
import { PortalFailure, PortalLoading } from '../components';
import { useMayAddProducts } from './access';
import { catalogCopy as c } from './copy';

/**
 * Where it is sold (M-adv-payments-core-21 channel availability, J-merchant-03 step 6): one row per store, one box per
 * channel. Every box starts on; the roles that manage products turn one off or on again, except in an archived store.
 */
export function ProductAvailabilitySection({ portal, product }: { portal: PortalApi; product: MerchantProduct }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const { resource, reload } = useResource(
    (signal) => portal.availability(product.id, signal),
    `portal:catalog:availability:${product.id}`,
  );
  const [changed, setChanged] = useState<ProductAvailability | null>(null);
  // The box being changed shows its new state until the service answers, and goes back if it refuses.
  const [pending, setPending] = useState<{ key: string; sold: boolean } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = pending !== null;

  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  const where = changed ?? resource.data;

  async function set(storeId: string, store: string, channel: SaleChannel, sold: boolean) {
    setPending({ key: `${storeId}|${channel}`, sold });
    setNote(null);
    try {
      const result = await portal.setAvailability({ productId: product.id, storeId, channel, sold });
      if (result.ok) {
        setChanged(result.data);
        setNote({
          ok: true,
          text: t('availabilityChanged', {
            channel: t(`channel_${channel}`),
            store,
            state: t(sold ? 'availabilityState_on' : 'availabilityState_off'),
          }),
        });
      } else {
        setNote({ ok: false, text: result.message });
        // A store archived or a product deleted elsewhere: show where things stand now.
        setChanged(null);
        reload();
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <PaySection title={t('availabilityTitle')} description={t('availabilityPurpose')}>
      {where.stores.length === 0 ? (
        <p className="muted">
          {t('availabilityNoStores')}{' '}
          {may.allowed && (
            <a className="text-link" href="/pay/settings/stores">
              {t('availabilityStoresLink')}
            </a>
          )}
        </p>
      ) : (
        <>
          <DataTable label={t('availabilityLabel')} headers={[t('storeColName'), ...SALE_CHANNELS.map((ch) => t(`channel_${ch}`))]}>
            {where.stores.map((store) => (
              <tr key={store.storeId}>
                <td>{store.status === 'archived' ? t('availabilityArchivedStore', { name: store.name }) : store.name}</td>
                {SALE_CHANNELS.map((channel) => (
                  <td key={channel}>
                    <label className="pp-check">
                      <input
                        type="checkbox"
                        aria-label={t('availabilitySoldAt', { channel: t(`channel_${channel}`), store: store.name })}
                        checked={pending?.key === `${store.storeId}|${channel}` ? pending.sold : store.channels[channel]}
                        disabled={!may.allowed || busy || store.status !== 'active'}
                        onChange={(e) => void set(store.storeId, store.name, channel, e.target.checked)}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </DataTable>
          {note && (
            <p className={note.ok ? 'pp-confirmed' : 'pp-callout'} role={note.ok ? 'status' : 'alert'}>
              {note.text}
            </p>
          )}
        </>
      )}
    </PaySection>
  );
}
