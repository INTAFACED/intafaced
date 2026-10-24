import type { ContractPart } from '../mock-contract-kit';

const write = 'a write: the stand-in answers it, and the Playwright run exercises it';
export const catalogContract: ContractPart = {
  cases: [
    { method: 'products', run: (p) => p.products('', undefined) },
    { method: 'product', run: (p) => p.product('c1000001-0000-4000-8000-000000000001') },
    { method: 'productImageRules', run: (p) => p.productImageRules() },
    {
      method: 'createProduct',
      run: (p) => p.createProduct({ requestId: 'c3000001-0000-4000-8000-000000000001', name: 'TEST Poster', type: 'physical' }),
    },
    { method: 'importProducts', run: (p) => p.importProducts({ csv: 'name,type\nTEST Mug,physical\nTEST Toy,toy\n', commit: false }) },
    { method: 'copyCatalog', run: (p) => p.copyCatalog('test', 'live') },
    { method: 'stores', run: (p) => p.stores('', undefined) },
    {
      method: 'createStore',
      run: (p) => p.createStore({ requestId: 'c3000001-0000-4000-8000-000000000003', name: 'TEST Stall', timezone: 'Europe/Berlin' }),
    },
    { method: 'availability', run: (p) => p.availability('c1000001-0000-4000-8000-000000000001') },
    { method: 'prices', run: (p) => p.prices('c1000001-0000-4000-8000-000000000001', undefined) },
    { method: 'monthlyPriceChoices', run: (p) => p.monthlyPriceChoices('USDC', '20') },
    {
      method: 'createPrice',
      run: (p) =>
        p.createPrice({
          requestId: 'c3000001-0000-4000-8000-000000000002',
          productId: 'c1000001-0000-4000-8000-000000000001',
          billing: 'one_time',
          kind: 'fixed',
          assetId: 'USDC',
          amount: '20',
        }),
    },
  ],
  notMocked: {
    setDefaultPrice: write,
    quotePrice: 'quotes a price the same run added; the Playwright run checks it',
    uploadProductImage: write,
    archiveProduct: write,
    unarchiveProduct: write,
    deleteProduct: write,
    archiveStore: write,
    reopenStore: write,
    setAvailability: write,
    replacePrice: write,
    priceUsage: 'reads what uses a price the same run added; the catalogue view tests and the Playwright run check it',
    pricedProduct: 'reads back a price the same run added; the subscription view tests and the Playwright run check it',
    productImage: 'reads back an image the same run uploaded; the catalogue view tests draw it',
  },
};
