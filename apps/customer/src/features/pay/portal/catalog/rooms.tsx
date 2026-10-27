import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { catalogCopy } from './copy';
import { Products } from './Products';
import { Stores } from './Stores';

const t = catalogCopy.t;

/** The product catalogue: the list, Add a product, Import products and one product (J-merchant-03). Every role reads; the page gates adding. */
const products: RoomDef = {
  header: (route) =>
    route.room === 'products'
      ? { title: t('productsTitle'), purpose: t('productsPurpose') }
      : route.room === 'product-new'
        ? { title: t('newTitle'), purpose: t('newPurpose') }
        : route.room === 'product-import'
          ? { title: t('importTitle'), purpose: t('importPurpose') }
          : { title: t('productTitle'), purpose: t('productPurpose') },
  here: '/pay/products',
  render: (route, { portal }) => (
    <WithAccount>
      {() => (
        <Requires need="products.read">
          <Products portal={portal} route={route} />
        </Requires>
      )}
    </WithAccount>
  ),
};

/** Stores (M-adv-org-access-05): every role reads; the page gates adding and archiving. */
const stores: RoomDef = {
  header: () => ({ title: t('storesTitle'), purpose: t('storesPurpose') }),
  here: '/pay/settings/stores',
  render: (_route, { portal }) => (
    <WithAccount>
      {() => (
        <Requires need="products.read">
          <Stores portal={portal} />
        </Requires>
      )}
    </WithAccount>
  ),
};

export const catalogRooms: RoomTable = {
  'settings-stores': stores,
  products,
  'product-new': products,
  'product-import': products,
  product: products,
};
