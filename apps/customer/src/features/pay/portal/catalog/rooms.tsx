import { Requires } from '../access/MerchantAccess';
import { WithAccount } from '../access/WithAccount';
import type { RoomDef, RoomTable } from '../rooms-model';
import { catalogCopy } from './copy';
import { Products } from './Products';
import { ProductsRoom } from './ProductList';
import { StoresRoom } from './Stores';

const t = catalogCopy.t;

/** The product catalogue: the list and one product on the record-list template (`./ProductList`), which draws their heading. */
const products: RoomDef = {
  header: (route) =>
    route.room === 'products'
      ? { title: t('productsTitle'), purpose: t('productsPurpose') }
      : { title: t('productTitle'), purpose: t('productPurpose') },
  here: '/pay/products',
  ownTitle: true,
  render: (route, { portal }) => <ProductsRoom portal={portal} productId={route.param} />,
};

/** Add a product and Import products (J-merchant-03). Every role reads; the page gates adding. */
const productForms: RoomDef = {
  header: (route) =>
    route.room === 'product-new'
      ? { title: t('newTitle'), purpose: t('newPurpose') }
      : { title: t('importTitle'), purpose: t('importPurpose') },
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
  ownTitle: true,
  render: (_route, { portal }) => <StoresRoom portal={portal} />,
};

export const catalogRooms: RoomTable = {
  'settings-stores': stores,
  products,
  'product-new': productForms,
  'product-import': productForms,
  product: products,
};
