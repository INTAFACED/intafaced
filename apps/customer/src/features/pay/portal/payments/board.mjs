// The routes the screenshot board shoots for the payments pages: [id from the page inventory, title, address, also shoot at phone width, who is signed in].
// Read by ../board/shoot.mjs and ../board/crawl.mjs. Keep this list to routes this package owns, and add a row when you add a page.
// The signed-in person defaults to the owner; 'payfac' signs in as a platform owner so Network and Permissions show.
export const board = [
  ['P05', 'Overview', '/pay/merchant', true],
  ['P06', 'Payments', '/pay/payments', true],
  ['P07', 'Payment detail', '/pay/payments/aa000001-0000-4000-8000-000000000001', true],
  ['P11', 'Disputes', '/pay/disputes', true],
  ['P12', 'Dispute detail', '/pay/disputes/d0000001-0000-4000-8000-000000000001', false],
  ['P13', 'Payment links', '/pay/links', true],
  ['P14', 'Create link', '/pay/links/new', false],
  ['P15', 'Link detail', '/pay/links/1c000001-0000-4000-8000-000000000001', false],
  ['P16', 'Checkout', '/pay/checkout', false],
  ['P17', 'Subscriptions', '/pay/subscriptions', false],
  ['P18', 'Subscription detail', '/pay/subscriptions/1e000001-0000-4000-8000-000000000001', false],
  ['P19', 'New subscription', '/pay/subscriptions/new', false],
  ['P20', 'Invoices', '/pay/invoices', true],
  ['P21', 'Invoice detail', '/pay/invoices/1a000002-0000-4000-8000-000000000002', true],
  ['P20n', 'New invoice', '/pay/invoices/new', false],
  ['P22', 'Customers', '/pay/customers', true],
  ['P23', 'Customer detail', '/pay/customers/TEST-cust-001', false],
];
