import { useState } from 'react';
import { Checkbox } from '@intafaced/ui/lit';
import type { MerchantProduct } from '@intafaced/contracts/merchant-catalog';
import { SALE_CHANNELS, type ProductAvailability, type SaleChannel } from '@intafaced/contracts/merchant-stores';
import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { Failure, Grid, Loading, Section } from '../volt/parts';
import { useMayAddProducts } from './access';
import { catalogCopy as c } from './copy';

/** A service's answer: done in the kit's hint, refused in its refusal look. */
const DONE_LOOK = 'lt-hint';
const REFUSED_LOOK = 'lt-refusal';

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

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
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
    <Section title={t('availabilityTitle')} description={t('availabilityPurpose')}>
      {where.stores.length === 0 ? (
        <p className="lt-muted">
          {t('availabilityNoStores')}{' '}
          {may.allowed && (
            <a className="lt-link" href="/pay/settings/stores">
              {t('availabilityStoresLink')}
            </a>
          )}
        </p>
      ) : (
        <>
          <Grid label={t('availabilityLabel')} headers={[t('storeColName'), ...SALE_CHANNELS.map((ch) => t(`channel_${ch}`))]}>
            {where.stores.map((store) => (
              <tr key={store.storeId}>
                <td>{store.status === 'archived' ? t('availabilityArchivedStore', { name: store.name }) : store.name}</td>
                {SALE_CHANNELS.map((channel) => (
                  <td key={channel}>
                    <Checkbox
                      checked={pending?.key === `${store.storeId}|${channel}` ? pending.sold : store.channels[channel]}
                      disabled={!may.allowed || busy || store.status !== 'active'}
                      onCheckedChange={(sold) => void set(store.storeId, store.name, channel, sold)}
                    >
                      <span className="lt-sr">{t('availabilitySoldAt', { channel: t(`channel_${channel}`), store: store.name })}</span>
                    </Checkbox>
                  </td>
                ))}
              </tr>
            ))}
          </Grid>
          {note && (
            <p
              className={note.ok ? DONE_LOOK : REFUSED_LOOK}
              data-refusal={note.ok ? undefined : 'refused'}
              role={note.ok ? 'status' : 'alert'}
            >
              {note.text}
            </p>
          )}
        </>
      )}
    </Section>
  );
}
