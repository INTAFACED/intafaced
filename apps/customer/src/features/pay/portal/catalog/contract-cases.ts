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
  ],
  notMocked: {
    uploadProductImage: write,
    productImage: 'reads back an image the same run uploaded; the catalogue view tests draw it',
  },
};
