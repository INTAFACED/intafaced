import { defineCopy } from '../../shared/i18n';

/** Copy for the audit room's per-product list (D-developer-compliance-02). It never claims an audit that is not recorded. */
const en = {
  productsTitle: 'Audits',
  productsNote:
    'Each product with the external audit recorded for it. A row is filled only from a report the owner records; our own tests never count as an audit.',
  hdr_product: 'Product',
  hdr_external: 'External audit',
  hdr_internal: 'Our checks',
  product_swap: 'Swap',
  product_pools: 'Pools',
  product_lending: 'Lending',
  product_orders: 'Orders',
  product_launch: 'Launch',
  product_bridge: 'Bridge',
  externalNone: 'External audit: not done',
  externalDone: 'External audit by {by}, {at}. Scope: {scope}.',
  externalReport: 'Read the report',
  externalNoLink: 'The report is kept at {path}.',
  internal: 'Our own tests, not an audit',
  internalNone: 'None recorded',
} as const;

export const auditCopy = defineCopy('customer.protocol.audit', en);
